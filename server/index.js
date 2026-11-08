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
import { Replayer, describe } from './replay.js';
import { nextUp } from './weekend.js';
import { Recorder, recordingPath } from './recorder.js';
import { LapHistory } from '../public/js/history.js';
import { applyMessage as applyMsg } from '../public/js/merge.js';
import { Timeline, MAX_DELAY_S } from './timeline.js';
import { loadConfig, saveConfig } from './config.js';
import { INIT } from '../public/js/merge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const cacheDir = path.join(root, 'cache');
const recordingsDir = path.join(root, 'recordings');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

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
const history = new LapHistory();
let sourceOpts = { f1tv: flag('f1tv'), speed: Number(opt('speed', 1)), skip: opt('skip', null) == null ? null : Number(opt('skip', 0)), file: null };

function latestRecording() {
  if (!fs.existsSync(recordingsDir)) return null;
  const files = fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(recordingsDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  return files[0] ? path.join(recordingsDir, files[0].f) : null;
}

function startSource() {
  // Only live sessions are recorded (a demo or replay must never be saved as a session).
  if (mode !== 'live' && recorder) { recorder.close(); recorder = null; }
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
  source.on('init', (state) => {
    const fresh = state?.SessionInfo?.Key !== history.sessionKey;
    timeline.push(INIT, state);
    history.onMessage(Date.now(), '__init', state, timeline.state);
    if (fresh && mode === 'live') backfillHistory(state);
    recorder?.init(state);
  });
  source.on('feed', (topic, data, ts) => {
    timeline.push(topic, data);
    history.onMessage(Date.now(), topic, data, timeline.state);
    recorder?.feed(topic, data, ts);
  });
  source.on('replay', (info) => broadcast({ type: 'replay', info }));
  source.on('skip', (e, state) => history.onMessage(e.t, e.type === 'init' ? '__init' : e.topic, e.data, state));
  source.start();
}

/** After a restart mid-session, rebuild the lap history from this session's recording. */
function backfillHistory(state) {
  const file = recordingPath(recordingsDir, state);
  if (!fs.existsSync(file)) return;
  try {
    const tmp = {};
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'init') { applyMsg(tmp, INIT, e.data); continue; }
      applyMsg(tmp, e.topic, e.data);
      if (e.topic === 'TimingData') { history.onMessage(e.t, e.topic, e.data, tmp); n++; }
    }
    console.log(`[history] rebuilt from recording (${n} timing messages)`);
  } catch (e) { console.warn('[history] backfill failed:', e.message); }
}

/** Swap live / demo / replay without restarting; every screen gets the new state. */
async function switchSource(newMode, opts = {}) {
  if (source) { source.removeAllListeners(); await source.stop?.(); }
  mode = newMode;
  sourceOpts = { f1tv: !!opts.f1tv, speed: Number(opts.speed) || 1, skip: opts.skip == null ? null : Number(opts.skip) || 0, file: opts.file || null };
  timeline = new Timeline();
  history.reset(null);
  sourceStatus = { state: 'starting', detail: '' };
  startSource();
  for (const c of clients) {
    send(c.ws, hello());
    sendFull(c);
  }
}

function hello() {
  return { type: 'hello', mode, status: statusPayload(), maxDelay: MAX_DELAY_S, serverNow: Date.now(), replay: mode === 'replay' ? source?.info?.() ?? null : null };
}

/** Replay: jump to a moment. Every screen starts again from the state at that moment. */
function replaySeek(sec) {
  timeline = new Timeline();
  history.reset(null);
  source.seek(sec);
  for (const c of clients) { send(c.ws, hello()); sendFull(c); }
}

// Replay list: title, length and key moments of each recording (cached until the file changes).
const describeCache = new Map();
function recordingList() {
  if (!fs.existsSync(recordingsDir)) return [];
  return fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl')).map((f) => {
    const file = path.join(recordingsDir, f);
    const st = fs.statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    let hit = describeCache.get(f);
    if (!hit || hit.key !== key) {
      let d;
      try { d = describe(file); } catch { d = { name: f, session: f.replace(/\.jsonl$/, '').replace(/_/g, ' '), broken: true, marks: [] }; }
      hit = { key, d };
      describeCache.set(f, hit);
    }
    return { ...hit.d, size: st.size, mtime: st.mtimeMs, recording: !!(recorder?.file && path.resolve(recorder.file) === file) };
  }).sort((a, b) => (b.recordedAt || b.mtime) - (a.recordedAt || a.mtime));
}

// Remaining sessions this season, from the free Jolpica (Ergast) API; cached 6h.
let scheduleCache = { at: 0, data: null };
let radarCache = { at: 0, data: null };

// Rain forecast for the next 3 hours (15-min steps) on a 7×7 grid around the
// circuit, from Open-Meteo (free, no account). Cached 20 min per location.
const forecastCache = new Map();
async function rainForecast(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = forecastCache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60000) return hit.data;
  const N = 7, span = 1.5, k = 1 / Math.cos((lat * Math.PI) / 180); // ~165 km each way
  const lats = [], lons = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    lats.push(+(lat + span - (2 * span * i) / (N - 1)).toFixed(3));
    lons.push(+(lon - span * k + (2 * span * k * j) / (N - 1)).toFixed(3));
  }
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&minutely_15=precipitation&forecast_minutely_15=12&hourly=precipitation_probability&forecast_hours=4&timezone=GMT`;
  const r = await fetch(u, { headers: { 'user-agent': 'pitwall-dashboard' } });
  if (!r.ok) throw new Error(`forecast ${r.status}`);
  const arr = await r.json();
  const pts = Array.isArray(arr) ? arr : [arr];
  const times = (pts[0]?.minutely_15?.time || []).map((t) => `${t}:00Z`);
  const centre = pts[Math.floor(pts.length / 2)];
  const data = {
    generated: Date.now(), n: N, lats, lons, times,
    precip: times.map((_, ti) => pts.map((p) => Number(p.minutely_15?.precipitation?.[ti]) || 0)), // mm per 15 min
    chance: (centre?.hourly?.time || []).map((t, i) => ({ t: `${t}:00Z`, p: centre.hourly.precipitation_probability?.[i] ?? null })),
  };
  forecastCache.set(key, { at: Date.now(), data });
  return data;
}
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
  // Circuit coordinates, for the weather radar.
  const raceList = races.map((r) => ({
    name: r.raceName, date: r.date, circuit: r.Circuit?.circuitName, locality: r.Circuit?.Location?.locality,
    country: r.Circuit?.Location?.country, lat: Number(r.Circuit?.Location?.lat), lon: Number(r.Circuit?.Location?.long),
  }));
  scheduleCache = { at: Date.now(), data: { sessions, races: raceList } };
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

// Driver photos, team logos and car pictures from F1's public image service,
// cached on disk so they load instantly (also on the phone) and survive outages.
const IMG_TRANSFORMS = { face: 'c_fill,w_160,h_160,g_face', logo: 'c_fit,h_64', car: 'c_fit,w_640' };
async function f1Image(res, id, t) {
  if (!/^common\/f1\/\d{4}\/[a-z0-9]+(\/[a-z0-9]+)?\/[a-z0-9]+$/.test(id) || !IMG_TRANSFORMS[t]) return sendJson(res, 400, { error: 'bad image id' });
  const file = path.join(cacheDir, 'img', `${t}_${id.replace(/\//g, '_')}`);
  let buf, type;
  if (fs.existsSync(file) && fs.existsSync(`${file}.type`)) {
    buf = fs.readFileSync(file);
    type = fs.readFileSync(`${file}.type`, 'utf8');
  } else {
    const r = await fetch(`https://media.formula1.com/image/upload/${IMG_TRANSFORMS[t]}/q_auto/v1/${id}`, { headers: { 'user-agent': 'pitwall-dashboard' } }).catch(() => null);
    if (!r?.ok) return sendJson(res, 404, { error: 'image unavailable' });
    buf = Buffer.from(await r.arrayBuffer());
    type = r.headers.get('content-type') || 'image/png';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    fs.writeFileSync(`${file}.type`, type);
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=604800' });
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
        version: VERSION, folder: root,
      });
    }
    if (url.pathname === '/api/circuit') {
      const text = await circuit(Number(url.searchParams.get('key')), Number(url.searchParams.get('year')) || new Date().getFullYear());
      if (!text) return sendJson(res, 404, { error: 'no outline' });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' });
      return res.end(text);
    }
    if (url.pathname === '/api/radio') return await radio(req, res, url.searchParams.get('path') || '');
    if (url.pathname === '/api/img') return await f1Image(res, url.searchParams.get('id') || '', url.searchParams.get('t') || 'face');
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
      return sendJson(res, 200, { files: recordingList(), canSwitch: isLocal(req), mode });
    }
    if (url.pathname === '/api/replay' && req.method === 'POST') {
      // Play / pause / speed / jump. Any screen may drive a replay (it is not live data).
      if (mode !== 'replay' || !source?.seek) return sendJson(res, 409, { error: 'No replay is playing.' });
      const body = await readBody(req);
      const v = Number(body.value);
      if (body.action === 'pause') source.pause();
      else if (body.action === 'play') source.play();
      else if (body.action === 'speed' && v > 0) source.setSpeed(v);
      else if (body.action === 'seek' && Number.isFinite(v)) replaySeek(v);
      else if (body.action === 'jump' && Number.isFinite(v)) replaySeek(source.position() / 1000 + v);
      else return sendJson(res, 400, { error: 'unknown action' });
      return sendJson(res, 200, source.info());
    }
    if (url.pathname === '/api/history') return sendJson(res, 200, history.snapshot());
    if (url.pathname === '/api/forecast') {
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      if (!(Math.abs(lat) <= 85) || !(Math.abs(lon) <= 180)) return sendJson(res, 400, { error: 'bad location' });
      const data = await rainForecast(lat, lon).catch((e) => ({ error: e.message }));
      return sendJson(res, data.error ? 502 : 200, data);
    }
    if (url.pathname === '/api/radar') {
      // RainViewer's list of radar frames (last ~2 hours), cached for 2 minutes.
      if (!radarCache.data || Date.now() - radarCache.at > 120000) {
        const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', { headers: { 'user-agent': 'pitwall-dashboard' } }).catch(() => null);
        if (r?.ok) radarCache = { at: Date.now(), data: await r.json() };
      }
      return radarCache.data ? sendJson(res, 200, radarCache.data) : sendJson(res, 502, { error: 'radar unavailable' });
    }
    if (url.pathname === '/api/nextup') {
      // Next session, starting grid (after penalties) and start-time weather, for the screen between sessions.
      const sch = await schedule().catch(() => null);
      return sendJson(res, 200, await nextUp(sch, { force: url.searchParams.has('fresh'), state: timeline.state }));
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
// The HTTP server's own handler (below) explains "port in use"; don't crash here first.
wss.on('error', (e) => { if (e.code !== 'EADDRINUSE') console.error('[ws]', e.message); });
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
  send(ws, hello());
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

// Every 5 s tell each screen when F1 data last arrived, so it can warn about silence.
setInterval(() => broadcast({ type: "ping", serverNow: Date.now(), lastDataAt: source?.lastDataAt || null, mode }), 5000);

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
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use: Pit Wall (or another app) is already running.`);
    console.error(`  Close the other Pit Wall window first, or start this one on another port with --port 3001.\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(port, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('');
  console.log(`  Pit Wall v${VERSION} · ${mode.toUpperCase()}${mode === 'live' ? (cfg.f1tvToken ? ' · F1 TV data on' : ' · free data') : ''}`);
  console.log(`  Running from:    ${root}`);
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
