// Pit Wall front end: one websocket, one state object, views that redraw on change.
import { applyMessage } from './merge.js';
import { parseLap, esc, fmtClock } from './format.js';
import { EstimatedTracker, GpsTracker } from './tracker.js';
import { Header } from './views/header.js';
import { Tower } from './views/tower.js';
import { TrackMap } from './views/map.js';
import { RaceControl } from './views/racecontrol.js';
import { TeamRadio } from './views/radio.js';
import { Strategy } from './views/strategy.js';
import { Telemetry } from './views/telemetry.js';
import { DriverSheet } from './views/sheet.js';
import { Settings } from './views/settings.js';

const store = {
  state: {},
  status: {},
  connected: false,
  delay: Number(localStorage.getItem('delay') ?? NaN),
  maxDelay: 300,
  clockOffset: 0,
  selected: null,
  fastestLap: null,
  ws: null,

  /** "Now" on the data timeline this screen is showing (server clock minus delay). */
  playNow() { return Date.now() + this.clockOffset - this.delay * 1000; },

  setDelay(sec) {
    this.delay = Math.max(0, Math.min(this.maxDelay, Math.round(sec)));
    localStorage.setItem('delay', String(this.delay));
    send({ type: 'delay', seconds: this.delay });
    dirty.add('*');
  },
  sync(driver) { send({ type: 'sync', driver }); },

  select(num, { open = false } = {}) {
    this.selected = this.selected === num && !open ? null : num;
    if (open) sheet.open(num);
    dirty.add('*');
  },

  toast(text, cls = '') {
    const t = document.createElement('div');
    t.className = `toast ${cls}`;
    t.textContent = text;
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), cls ? 9000 : 5000);
  },

  notify(tab) {
    // Little dot on a tab that isn't visible right now.
    const desk = document.body.dataset.dock !== tab;
    const mob = document.body.dataset.mtab !== tab;
    document.getElementById(`dot-${tab}`)?.classList.toggle('on', desk);
    document.getElementById(`mdot-${tab}`)?.classList.toggle('on', mob);
  },

  renderEmpty(el) { renderEmpty(el); },
};

const estimated = new EstimatedTracker();
const gps = new GpsTracker();
const header = new Header(store);
const tower = new Tower(store);
const map = new TrackMap(store, estimated, gps);
const rc = new RaceControl(store);
const radio = new TeamRadio(store);
const strategy = new Strategy(store);
const telemetry = new Telemetry(store);
const sheet = new DriverSheet(store);
new Settings(store);

const views = [header, tower, map, rc, radio, strategy, telemetry, sheet];
const dirty = new Set(['*']);

// ------------------------------------------------------------------ tabs
document.getElementById('dock-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dock]');
  if (!b) return;
  document.body.dataset.dock = b.dataset.dock;
  localStorage.setItem('dock', b.dataset.dock);
  document.getElementById(`dot-${b.dataset.dock}`)?.classList.remove('on');
});
document.getElementById('bottomnav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mtab]');
  if (!b) return;
  document.body.dataset.mtab = b.dataset.mtab;
  document.getElementById(`mdot-${b.dataset.mtab}`)?.classList.remove('on');
  dirty.add('*');
});
document.body.dataset.dock = localStorage.getItem('dock') || 'control';
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { sheet.close(); document.getElementById('delay-pop').hidden = true; }
});

// ------------------------------------------------------------------ data
function computeDerived() {
  let best = null, bestV = Infinity;
  for (const l of Object.values(store.state.TimingData?.Lines || {})) {
    const v = parseLap(l?.BestLapTime?.Value);
    if (v && v < bestV) { bestV = v; best = l.BestLapTime.Value; }
  }
  store.fastestLap = best;
}

function onState(m) {
  store.state = m.state || {};
  if (Number.isFinite(m.delay)) store.delay = m.delay;
  estimated.reset(store.state, m.at);
  gps.reset();
  telemetry.reset();
  map.reset(store.state);
  computeDerived();
  dirty.add('*');
}

function onMsgs(msgs) {
  for (const [t, topic, data] of msgs) {
    applyMessage(store.state, topic, data);
    estimated.onMessage(t, topic, data, store.state);
    gps.onMessage(t, topic, data);
    telemetry.onMessage(t, topic, data);
    map.onMessage(t, topic, data);
    rc.onMessage(t, topic, data);
    radio.onMessage(t, topic, data);
    dirty.add(topic);
  }
  computeDerived();
}

function send(msg) {
  if (store.ws?.readyState === 1) store.ws.send(JSON.stringify(msg));
}

let retry = 500;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  store.ws = ws;
  ws.onopen = () => { store.connected = true; retry = 500; dirty.add('*'); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') {
      store.clockOffset = m.serverNow - Date.now();
      store.status = m.status || {};
      store.maxDelay = m.maxDelay || 300;
      if (Number.isFinite(store.delay)) send({ type: 'delay', seconds: store.delay });
      dirty.add('*');
    } else if (m.type === 'state') onState(m);
    else if (m.type === 'msgs') onMsgs(m.msgs);
    else if (m.type === 'status') { store.status = m.status; dirty.add('*'); }
    else if (m.type === 'toast') store.toast(m.text);
  };
  ws.onclose = () => {
    store.connected = false;
    dirty.add('*');
    setTimeout(connect, retry);
    retry = Math.min(8000, retry * 1.6);
  };
}
if (!Number.isFinite(store.delay)) store.delay = 0;
connect();

// ------------------------------------------------------------------ render loop
let lastUpdate = 0;
function loop() {
  const now = store.playNow();
  const t = performance.now();
  if (dirty.size && t - lastUpdate > 90) {
    lastUpdate = t;
    dirty.clear();
    for (const v of views) {
      try { v.update?.(); } catch (e) { console.error(v.constructor.name, e); }
    }
  }
  for (const v of views) {
    try { v.frame?.(now); } catch (e) { console.error(v.constructor.name, e); }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.addEventListener('resize', () => dirty.add('*'));

// Keep the phone screen awake while watching (where supported).
async function wakeLock() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', wakeLock);
wakeLock();

// ------------------------------------------------------------------ empty state
let schedule = null;
async function loadSchedule() {
  try { schedule = await fetch('/api/schedule').then((r) => r.json()); } catch { schedule = { sessions: [] }; }
}
loadSchedule();

function renderEmpty(el) {
  const next = (schedule?.sessions || []).find((x) => Date.parse(x.start) > Date.now() - 2 * 3600e3);
  const live = next && Date.parse(next.start) <= Date.now();
  const cd = next ? fmtClock((Date.parse(next.start) - Date.now()) / 1000) : '';
  const days = next ? Math.floor((Date.parse(next.start) - Date.now()) / 86400e3) : 0;
  const html = `<div>
    <h3>${store.connected ? 'No live session right now' : 'Connecting to Pit Wall…'}</h3>
    <p>${store.connected ? 'Timing appears here automatically when cars go out. Leave this page open.' : 'Make sure Pit Wall is running on your laptop.'}</p>
    ${next ? `<div class="next"><div class="k">${live ? 'Happening now' : 'Next session'}</div><div class="v">${esc(next.race)} · ${esc(next.name)}</div>
      <div class="cd">${live ? 'Starting…' : days >= 1 ? `${days}d ${fmtClock(((Date.parse(next.start) - Date.now()) / 1000) % 86400)}` : cd}</div>
      <div class="k" style="margin-top:4px">${new Date(next.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} your time</div></div>` : ''}
    <div class="actions"><button class="btn" id="empty-settings">Try the demo race</button></div>
  </div>`;
  if (el.dataset.k !== html) {
    el.dataset.k = html;
    el.innerHTML = html;
    el.querySelector('#empty-settings')?.addEventListener('click', () => document.getElementById('settings-btn').click());
  }
}
setInterval(() => { if (!document.getElementById('empty').hidden) dirty.add('*'); }, 1000);
