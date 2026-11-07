// Pit Wall front end: one websocket, one state object, views that redraw on change.
import { applyMessage } from './merge.js';
import { parseLap, esc, fmtClock, sessionPhase } from './format.js';
import { EstimatedTracker, GpsTracker } from './tracker.js';
import { Layout, WIDGETS, PRESETS } from './layout.js';
import { Header } from './views/header.js';
import { Tower } from './views/tower.js';
import { TrackMap } from './views/map.js';
import { RaceControl } from './views/racecontrol.js';
import { TeamRadio } from './views/radio.js';
import { Strategy } from './views/strategy.js';
import { Telemetry } from './views/telemetry.js';
import { Battles } from './views/battles.js';
import { Moments } from './views/moments.js';
import { Radar } from './views/radar.js';
import { DriverSheet } from './views/sheet.js';
import { Settings } from './views/settings.js';

const dirty = new Set(['*']);

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
  dirty() { dirty.add('*'); },

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

  setLook({ density, accent, theme }) {
    if (density) { document.body.dataset.density = density; localStorage.setItem('density', density); }
    if (accent) { document.body.dataset.accent = accent; localStorage.setItem('accent', accent); }
    if (theme) {
      document.body.dataset.theme = theme;
      localStorage.setItem('theme', theme);
      document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--panel').trim();
    }
    tower.colKey = '';
    dirty.add('*');
  },

  toast(text, cls = '') {
    const t = document.createElement('div');
    t.className = `toast ${cls}`;
    t.textContent = text;
    document.getElementById('toasts').append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 280); }, cls ? 9000 : 5000);
  },

  notify(widget) { layout.notify(widget); },
  renderEmpty(el) { renderEmpty(el); },
  openLayoutPop() { openLayoutPop(document.getElementById('layout-btn')); },
  onLayout() { dirty.add('*'); },
};

const ACCENTS = ['mono', 'blue', 'orange', 'lime'];
document.body.dataset.density = localStorage.getItem('density') || 'comfortable';
document.body.dataset.accent = ACCENTS.includes(localStorage.getItem('accent')) ? localStorage.getItem('accent') : 'mono';
document.body.dataset.theme = localStorage.getItem('theme') === 'paper' ? 'paper' : 'dark';
document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--panel').trim();

const estimated = new EstimatedTracker();
const gps = new GpsTracker();
const header = new Header(store);
const tower = new Tower(store);
const map = new TrackMap(store, estimated, gps);
const rc = new RaceControl(store);
const radio = new TeamRadio(store);
const strategy = new Strategy(store);
const telemetry = new Telemetry(store);
const battles = new Battles(store);
const moments = new Moments(store);
const radar = new Radar(store);
const sheet = new DriverSheet(store);
new Settings(store);
const layout = new Layout(store);

const views = [header, tower, map, rc, radio, strategy, telemetry, battles, moments, radar, sheet];

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && layout.focus && document.querySelectorAll('.popover:not([hidden]), .menu:not([hidden]), dialog[open]').length === 0) layout.setFocus(null);
  if (e.key === 'Escape') { sheet.close(); for (const id of ['delay-pop', 'layout-pop', 'cols-pop', 'panel-menu']) document.getElementById(id).hidden = true; }
});

// ------------------------------------------------------------------ layout popover
const lpop = document.getElementById('layout-pop');
document.getElementById('layout-btn').addEventListener('click', (e) => { e.stopPropagation(); if (lpop.hidden) openLayoutPop(e.currentTarget); else lpop.hidden = true; });
document.addEventListener('pointerdown', (e) => { if (!lpop.hidden && !lpop.contains(e.target) && !e.target.closest('#layout-btn')) lpop.hidden = true; });

function thumb(p) {
  const cols = p.layout.cols;
  const tw = cols.reduce((a, c) => a + (c.w ?? 1), 0);
  return `<div class="thumb">${cols.map((c) => {
    const th = c.groups.reduce((a, g) => a + (g.h ?? 1), 0);
    return `<div class="t-col" style="flex:${c.w ?? 1}">${c.groups.map((g) => `<div class="t-grp" style="flex:${g.h ?? 1}"><span>${g.tabs.map((t) => WIDGETS[t].short).slice(0, 2).join(' · ')}</span></div>`).join('')}</div>`;
  }).join('')}</div>`;
}

function openLayoutPop(btn) {
  const cur = layout.state.preset;
  const density = document.body.dataset.density;
  const accent = document.body.dataset.accent;
  lpop.innerHTML = `
    <div class="pop-title">Layout</div>
    <p class="pop-help">Pick a starting point, then drag panel tabs to rearrange: drop on a tab bar to group, on an edge to split. Drag the gaps between panels to resize.</p>
    <div class="presets-grid">${Object.entries(PRESETS).map(([k, p]) => `<button class="preset${cur === k ? ' on' : ''}" data-preset="${k}">${thumb(p)}<b>${esc(p.name)}</b><span>${esc(p.desc)}</span></button>`).join('')}</div>
    <div class="pop-sec"><div class="pop-k">Text size</div><div class="seg">${['compact', 'comfortable', 'large'].map((d) => `<button data-density="${d}" class="${density === d ? 'on' : ''}">${d === 'large' ? 'Large (sofa)' : d[0].toUpperCase() + d.slice(1)}</button>`).join('')}</div></div>
    <div class="pop-sec"><div class="pop-k">Theme</div><div class="seg">${[['dark', 'Dark'], ['paper', 'Paper (light)']].map(([k, n]) => `<button data-theme="${k}" class="${document.body.dataset.theme === k ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <div class="pop-sec"><div class="pop-k">Accent</div><div class="swatches">${ACCENTS.map((a) => `<button data-accent="${a}" class="sw sw-${a}${accent === a ? ' on' : ''}" title="${a}"></button>`).join('')}</div></div>
    <div class="pop-sec"><div class="pop-k">Panels</div><div class="chips">${Object.entries(WIDGETS).map(([id, w]) => `<button data-panel="${id}" class="pchip${layout.placed(id) ? ' on' : ''}">${w.icon}${esc(w.title)}</button>`).join('')}</div></div>
    <div class="pop-foot"><button class="btn" data-reset>Reset to default</button></div>`;
  const r = btn.getBoundingClientRect();
  lpop.hidden = false;
  lpop.style.top = `${r.bottom + 8}px`;
  lpop.style.left = `${Math.max(8, Math.min(window.innerWidth - lpop.offsetWidth - 8, r.left - 40))}px`;
  lpop.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preset) layout.applyPreset(b.dataset.preset);
    else if (b.dataset.density) store.setLook({ density: b.dataset.density });
    else if (b.dataset.accent) store.setLook({ accent: b.dataset.accent });
    else if (b.dataset.theme) store.setLook({ theme: b.dataset.theme });
    else if (b.dataset.panel) layout.show(b.dataset.panel, !layout.placed(b.dataset.panel));
    else if (b.hasAttribute('data-reset')) { localStorage.removeItem('layout'); localStorage.removeItem('towerCols'); store.setLook({ density: 'comfortable', accent: 'mono', theme: 'dark' }); layout.applyPreset(window.innerWidth >= 1700 ? 'engineer' : 'pitwall'); }
    openLayoutPop(btn);
  };
}

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
  const sessionChanged = store.state.SessionInfo?.Key !== m.state?.SessionInfo?.Key;
  store.state = m.state || {};
  if (Number.isFinite(m.delay)) store.delay = m.delay;
  estimated.reset(store.state, m.at);
  gps.reset();
  telemetry.reset();
  map.reset(store.state);
  if (sessionChanged) { battles.reset(); moments.items = []; }
  moments.reset(store.state, m.at);
  store.clockSeen = { utc: store.state.ExtrapolatedClock?.Utc, t: m.at };
  computeDerived();
  dirty.add('*');
}

function onMsgs(msgs) {
  for (const [t, topic, data] of msgs) {
    applyMessage(store.state, topic, data);
    if (topic === 'ExtrapolatedClock') store.clockSeen = { utc: store.state.ExtrapolatedClock?.Utc, t };
    estimated.onMessage(t, topic, data, store.state);
    gps.onMessage(t, topic, data);
    telemetry.onMessage(t, topic, data);
    map.onMessage(t, topic, data);
    rc.onMessage(t, topic, data);
    radio.onMessage(t, topic, data);
    battles.onMessage(t, topic, data, store.state);
    moments.onMessage(t, topic, data, store.state);
    dirty.add(topic);
  }
  computeDerived();
}

function send(msg) {
  if (store.ws?.readyState === 1) store.ws.send(JSON.stringify(msg));
}

// ------------------------------------------------------------------ connection
// This screen <-> Pit Wall on the laptop. Reconnects by itself (and immediately
// when the device comes back online or the phone wakes up).
let retry = 500;
let retryTimer = null;
store.wsDownSince = null;
store.lastDataAt = null;

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (store.ws && store.ws.readyState <= 1) return; // already connecting / open
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  store.ws = ws;
  ws.onopen = () => {
    store.connected = true;
    retry = 500;
    if (store.wsDownSince && Date.now() - store.wsDownSince > 4000) store.toast('Reconnected to Pit Wall. Timing is up to date.', 'ok');
    store.wsDownSince = null;
    dirty.add('*');
  };
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
    else if (m.type === 'status') {
      const was = store.status?.state;
      store.status = m.status;
      if (m.status?.recoveredAfter) store.toast(`Back online after ${fmtClock(m.status.recoveredAfter / 1000)}. Timing caught up.`, 'ok');
      else if (was === 'live' && (m.status?.state === 'offline' || m.status?.state === 'reconnecting')) dirty.add('*');
      dirty.add('*');
    } else if (m.type === 'ping') {
      store.lastDataAt = m.lastDataAt;
      store.clockOffset = store.clockOffset * 0.8 + (m.serverNow - Date.now()) * 0.2;
    } else if (m.type === 'toast') store.toast(m.text);
  };
  ws.onclose = () => {
    if (store.ws !== ws) return;
    store.connected = false;
    if (!store.wsDownSince) store.wsDownSince = Date.now();
    dirty.add('*');
    retryTimer = setTimeout(connect, retry);
    retry = Math.min(5000, retry * 1.6);
  };
}
if (!Number.isFinite(store.delay)) store.delay = 0;
connect();
// Don't wait for the next retry when the network or the screen comes back.
window.addEventListener('online', () => { retry = 500; connect(); dirty.add('*'); });
window.addEventListener('offline', () => dirty.add('*'));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !store.connected) { retry = 500; connect(); } });

// ------------------------------------------------------------------ connection warning bar
const netbar = document.getElementById('netbar');
function renderNetbar() {
  const st = store.status || {};
  const now = Date.now();
  const serverNow = now + store.clockOffset;
  const ago = (t) => fmtClock(Math.max(0, (serverNow - t) / 1000));
  let text = '', cls = '';
  if (!navigator.onLine) {
    text = 'This device is offline. Timing will resume when it reconnects.'; cls = 'bad';
  } else if (!store.connected && store.wsDownSince && now - store.wsDownSince > 2500) {
    const long = now - store.wsDownSince > 15000;
    text = `Lost the connection to Pit Wall on your laptop · reconnecting… ${long ? '(is the Pit Wall window still open, and is this device on the same Wi-Fi?)' : ''}`; cls = 'bad';
  } else if (st.mode === 'live' && st.state === 'offline') {
    const retryIn = st.retryAt ? Math.max(0, Math.ceil((st.retryAt - serverNow) / 1000)) : null;
    text = `Internet connection lost on the laptop · retrying${retryIn != null ? ` in ${retryIn}s` : ''} · down ${st.downSince ? ago(st.downSince) : ''}. Timing below is frozen.`; cls = 'bad';
  } else if (st.mode === 'live' && (st.state === 'reconnecting' || st.state === 'connecting') && st.downSince) {
    text = `Connection to F1 interrupted (${st.detail || 'reconnecting'}) · reconnecting automatically · down ${ago(st.downSince)}`; cls = 'warn';
  } else if (st.mode === 'live' && st.state === 'live' && store.lastDataAt && serverNow - store.lastDataAt > 40000 && ['running', 'suspended', 'paused'].includes(sessionPhase(store.state))) {
    text = `No data from F1 for ${ago(store.lastDataAt)} · will reconnect automatically if this continues`; cls = 'warn';
  }
  netbar.hidden = !text;
  netbar.className = `netbar ${cls}`;
  const span = netbar.querySelector('span');
  if (span.textContent !== text) span.textContent = text;
}
setInterval(renderNetbar, 1000);

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
fetch('/api/schedule').then((r) => r.json()).then((s) => { schedule = s; store.schedule = s; dirty.add('*'); }).catch(() => { schedule = { sessions: [] }; });

function renderEmpty(el) {
  const next = (schedule?.sessions || []).find((x) => Date.parse(x.start) > Date.now() - 2 * 3600e3);
  const ms = next ? Date.parse(next.start) - Date.now() : 0;
  const live = next && ms <= 0;
  const days = Math.floor(ms / 86400e3);
  const html = `<div>
    <div class="empty-mark">${WIDGETS.tower.icon}</div>
    <h3>${store.connected ? 'No live session right now' : 'Connecting to Pit Wall…'}</h3>
    <p>${store.connected ? 'Timing appears here automatically when cars go out. Leave this page open.' : 'Make sure Pit Wall is running on your laptop.'}</p>
    ${next ? `<div class="next"><div class="k">${live ? 'Happening now' : 'Next session'}</div><div class="v">${esc(next.race)} · ${esc(next.name)}</div>
      <div class="cd">${live ? 'Starting…' : days >= 1 ? `${days}d ${fmtClock((ms / 1000) % 86400)}` : fmtClock(ms / 1000)}</div>
      <div class="k">${new Date(next.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} your time</div></div>` : ''}
    <div class="actions"><button class="btn primary" id="empty-demo">Try the demo race</button></div>
  </div>`;
  if (el.dataset.k !== html) {
    el.dataset.k = html;
    el.innerHTML = html;
    el.querySelector('#empty-demo')?.addEventListener('click', () => document.getElementById('settings-btn').click());
  }
}
setInterval(() => { if (!document.getElementById('empty').hidden) dirty.add('*'); }, 1000);
