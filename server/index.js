// Pit Wall server: connects to the data source, keeps a delayed timeline per
// screen, serves the dashboard, and lets phones on the same Wi-Fi connect.
//
//   npm start                      live F1 data (records every session to recordings/)
//   npm run demo                   simulated race, free data only
//   npm run demo -- --f1tv         simulated race incl. F1 TV data (telemetry, GPS map)
//   npm run replay -- [file] [--speed 5] [--skip 600]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

import { F1Feed } from './f1feed.js';
import { Simulator } from './simulator.js';
import { Replayer } from './replay.js';
import { Recorder } from './recorder.js';
import { Timeline, MAX_DELAY_S } from './timeline.js';
import { loadConfig, saveConfig } from './config.js';
import { INIT } from '../public/js/merge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const cacheDir = path.join(root, 'cache');
const recordingsDir = path.join(root, 'recordings');

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
let mode = flag('demo') ? 'demo' : flag('replay') ? 'replay' : 'live';
const cfg = loadConfig(root);
const port = Number(opt('port', cfg.port));

// ------------------------------------------------------------------ source
let timeline = new Timeline();
let recorder = null;
let source = null;
let sourceStatus = { state: 'starting', detail: '' };
let sourceOpts = { f1tv: flag('f1tv'), speed: Number(opt('speed', 1)), skip: Number(opt('skip', 0)), file: null };

function latestRecording() {
  if (!fs.existsSync(recordingsDir)) return null;
  const files = fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(recordingsDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  return files[0] ? path.join(recordingsDir, files[0].f) : null;
}

function startSource() {
  if (mode === 'demo') {
    source = new Simulator({ f1tv: sourceOpts.f1tv, speed: sourceOpts.speed });
  } else if (mode === 'replay') {
    const given = sourceOpts.file || argv.find((a, i) => !a.startsWith('--') && !['--speed', '--skip', '--port'].includes(argv[i - 1]));
    const file = !given ? latestRecording() : fs.existsSync(path.resolve(given)) ? path.resolve(given) : path.resolve(recordingsDir, given);
    if (!file || !fs.existsSync(file)) { console.error('No recording found. Record a live session first (npm start or npm run record).'); process.exit(1); }
    source = new Replayer(file, { speed: sourceOpts.speed, skipSeconds: sourceOpts.skip });
  } else {
    source = new F1Feed({ token: cfg.f1tvToken });
    recorder = flag('no-record') ? null : (recorder ?? new Recorder(recordingsDir));
  }
  source.on('status', (s) => { sourceStatus = s; console.log(`[source] ${s.state} ${s.detail || ''}`); broadcast({ type: 'status', status: statusPayload() }); });
  source.on('init', (state) => { timeline.push(INIT, state); recorder?.init(state); });
  source.on('feed', (topic, data, ts) => { timeline.push(topic, data); recorder?.feed(topic, data, ts); });
  source.start();
}

/** Swap live / demo / replay without restarting; every screen gets the new state. */
async function switchSource(newMode, opts = {}) {
  if (source) { source.removeAllListeners(); await source.stop?.(); }
  mode = newMode;
  sourceOpts = { f1tv: !!opts.f1tv, speed: Number(opts.speed) || 1, skip: Number(opts.skip) || 0, file: opts.file || null };
  timeline = new Timeline();
  sourceStatus = { state: 'starting', detail: '' };
  startSource();
  for (const c of clients) {
    send(c.ws, { type: 'hello', mode, status: statusPayload(), maxDelay: MAX_DELAY_S, serverNow: Date.now() });
    sendFull(c);
  }
}

// Remaining sessions this season, from the free Jolpica (Ergast) API; cached 6h.
let scheduleCache = { at: 0, data: null };
async function schedule() {
  if (scheduleCache.data && Date.now() - scheduleCache.at < 6 * 3600e3) return scheduleCache.data;
  const r = await fetch('https://api.jolpi.ca/ergast/f1/current.json', { headers: { 'user-agent': 'pitwall-dashboard' } });
  if (!r.ok) throw new Error(`schedule ${r.status}`);
  const races = (await r.json()).MRData?.RaceTable?.Races || [];
  const names = { FirstPractice: 'Practice 1', SecondPractice: 'Practice 2', ThirdPractice: 'Practice 3', SprintQualifying: 'Sprint Qualifying', SprintShootout: 'Sprint Shootout', Sprint: 'Sprint', Qualifying: 'Qualifying' };
  const sessions = [];
  for (const race of races) {
    for (const [k, label] of Object.entries(names)) if (race[k]?.date) sessions.push({ race: race.raceName, name: label, start: `${race[k].date}T${race[k].time || '00:00:00Z'}` });
    sessions.push({ race: race.raceName, name: 'Race', start: `${race.date}T${race.time || '00:00:00Z'}` });
  }
  sessions.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  scheduleCache = { at: Date.now(), data: { sessions } };
  return scheduleCache.data;
}

/** Accepts a bare token, or the whole `login-session` cookie (URL-encoded JSON). */
function extractToken(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (s.startsWith('%7B') || s.startsWith('%7b')) { try { s = decodeURIComponent(s); } catch { /* keep */ } }
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      return j?.data?.subscriptionToken || j?.subscriptionToken || '';
    } catch { return ''; }
  }
  return s.replace(/^Bearer\s+/i, '');
}

function statusPayload() {
  return { ...sourceStatus, mode, f1tv: mode === 'live' ? !!cfg.f1tvToken : !!sourceStatus.authenticated, tokenExpires: tokenExpiry(cfg.f1tvToken) };
}

function tokenExpiry(token) {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ helpers
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  // Prefer typical home-network ranges first.
  return out.sort((a, b) => (b.startsWith('192.168.') - a.startsWith('192.168.')));
}

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

// Circuit outlines come from MultiViewer's public API; cached on disk.
async function circuit(key, year) {
  fs.mkdirSync(path.join(cacheDir, 'circuits'), { recursive: true });
  for (const y of [year, year - 1, year - 2]) {
    const file = path.join(cacheDir, 'circuits', `${key}-${y}.json`);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  for (const y of [year, year - 1, year - 2]) {
    try {
      const r = await fetch(`https://api.multiviewer.app/api/v1/circuits/${key}/${y}`, { headers: { 'user-agent': 'pitwall-dashboard' } });
      if (!r.ok) continue;
      const text = await r.text();
      fs.writeFileSync(path.join(cacheDir, 'circuits', `${key}-${y}.json`), text);
      return text;
    } catch { /* offline */ }
  }
  // Demo track as a last resort so the map still renders.
  return key === 14 ? fs.readFileSync(path.join(root, 'server', 'demo', 'track.json'), 'utf8') : null;
}

// Team radio clips: proxied (and cached) so they work the same on every device,
// and so an F1 TV token can be attached if F1 ever locks them.
async function radio(req, res, clipPath) {
  if (!/^\d{4}\/[^?#]+\/TeamRadio\/[\w.-]+\.mp3$/.test(clipPath) || clipPath.includes('..')) return sendJson(res, 400, { error: 'bad path' });
  const file = path.join(cacheDir, 'radio', clipPath.replace(/[\\/:*?"<>|]+/g, '_'));
  if (!fs.existsSync(file)) {
    const headers = { 'user-agent': 'pitwall-dashboard' };
    if (cfg.f1tvToken) headers.authorization = `Bearer ${cfg.f1tvToken}`;
    const r = await fetch(`https://livetiming.formula1.com/static/${encodeURI(clipPath)}`, { headers }).catch(() => null);
    if (!r || !r.ok) return sendJson(res, r?.status || 502, { error: 'clip unavailable', status: r?.status });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  const buf = fs.readFileSync(file);
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : buf.length - 1;
    res.writeHead(206, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 });
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': buf.length, 'cache-control': 'max-age=86400' });
  res.end(buf);
}

// ------------------------------------------------------------------ http
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/info') {
      const ips = lanAddresses();
      const phoneUrl = ips[0] ? `http://${ips[0]}:${port}` : null;
      return sendJson(res, 200, {
        mode, status: statusPayload(), maxDelay: MAX_DELAY_S, defaultDelay: cfg.defaultDelay,
        phoneUrl, phoneQr: phoneUrl ? await QRCode.toDataURL(phoneUrl, { margin: 1, width: 220, color: { dark: '#0b0d10', light: '#ffffff' } }) : null,
        canEditSettings: isLocal(req),
      });
    }
    if (url.pathname === '/api/circuit') {
      const text = await circuit(Number(url.searchParams.get('key')), Number(url.searchParams.get('year')) || new Date().getFullYear());
      if (!text) return sendJson(res, 404, { error: 'no outline' });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' });
      return res.end(text);
    }
    if (url.pathname === '/api/radio') return await radio(req, res, url.searchParams.get('path') || '');
    if (url.pathname === '/api/token' && req.method === 'POST') {
      // Only from this computer, never from other devices on the network.
      if (!isLocal(req)) return sendJson(res, 403, { error: 'Change this on the computer running Pit Wall.' });
      const body = await readBody(req);
      const token = extractToken(body.token);
      if (body.token && !token) return sendJson(res, 400, { error: 'Could not find a subscriptionToken in that cookie.' });
      if (token && token.split('.').length !== 3) return sendJson(res, 400, { error: 'That does not look like an F1 TV token.' });
      cfg.f1tvToken = token || null;
      saveConfig(root, { f1tvToken: token });
      if (mode === 'live') await switchSource('live');
      return sendJson(res, 200, { ok: true, status: statusPayload() });
    }
    if (url.pathname === '/api/mode' && req.method === 'POST') {
      if (!isLocal(req)) return sendJson(res, 403, { error: 'Change the data source on the laptop running Pit Wall.' });
      const body = await readBody(req);
      if (!['live', 'demo', 'replay'].includes(body.mode)) return sendJson(res, 400, { error: 'unknown mode' });
      if (body.mode === 'replay') {
        const file = path.basename(String(body.file || ''));
        if (!file || !fs.existsSync(path.join(recordingsDir, file))) return sendJson(res, 400, { error: 'Recording not found.' });
        body.file = file;
      }
      await switchSource(body.mode, body);
      return sendJson(res, 200, { ok: true, mode });
    }
    if (url.pathname === '/api/recordings') {
      const files = fs.existsSync(recordingsDir) ? fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => { const st = fs.statSync(path.join(recordingsDir, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime) : [];
      return sendJson(res, 200, { files });
    }
    if (url.pathname === '/api/schedule') {
      try { return sendJson(res, 200, await schedule()); } catch (e) { return sendJson(res, 200, { sessions: [], error: e.message }); }
    }

    // static files
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(publicDir, p));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('[http]', e);
    sendJson(res, 500, { error: e.message });
  }
});

// ------------------------------------------------------------------ websocket
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  for (const c of clients) send(c.ws, msg);
}

function sendFull(c) {
  const at = Date.now() - c.delay * 1000;
  const { seq, state } = timeline.stateAt(at);
  c.seq = seq;
  send(c.ws, { type: 'state', at, delay: c.delay, state });
}

wss.on('connection', (ws) => {
  const c = { ws, delay: cfg.defaultDelay, seq: 0 };
  clients.add(c);
  send(ws, { type: 'hello', mode, status: statusPayload(), maxDelay: MAX_DELAY_S, serverNow: Date.now() });
  sendFull(c);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'delay') {
      c.delay = Math.max(0, Math.min(MAX_DELAY_S, Number(msg.seconds) || 0));
      sendFull(c);
    } else if (msg.type === 'sync') {
      // "I just saw this car cross the line on TV" -> delay = now - when the data saw it.
      const t = timeline.lastLapCrossing(String(msg.driver));
      if (t) {
        c.delay = Math.max(0, Math.min(MAX_DELAY_S, Math.round((Date.now() - t) / 100) / 10));
        sendFull(c);
      } else send(ws, { type: 'toast', text: 'No recent lap crossing for that car yet.' });
    }
  });
  ws.on('close', () => clients.delete(c));
});

// Stream each screen the updates that are now "due" for its delay.
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    const due = timeline.since(c.seq, now - c.delay * 1000);
    if (!due.length) continue;
    c.seq = due[due.length - 1].seq;
    send(c.ws, { type: 'msgs', msgs: due.map((e) => [e.t, e.topic, e.data]) });
  }
}, 100);

// ------------------------------------------------------------------ go
server.listen(port, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('');
  console.log(`  Pit Wall · ${mode.toUpperCase()}${mode === 'live' ? (cfg.f1tvToken ? ' · F1 TV data on' : ' · free data') : ''}`);
  console.log(`  On this laptop:  http://localhost:${port}`);
  if (ips[0]) console.log(`  On your phone:   http://${ips[0]}:${port}  (same Wi-Fi)`);
  console.log('');
  startSource();
});

process.on('SIGINT', async () => {
  await source?.stop?.();
  recorder?.close();
  process.exit(0);
});
