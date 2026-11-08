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
import { DriverPanel } from './views/driver.js';
import { Pace } from './views/pace.js';
import { LapHistory } from './history.js';
import { FlagShow } from './views/flagshow.js';
import { DriverSheet } from './views/sheet.js';
import { Settings } from './views/settings.js';
import { Replays, ReplayBar } from './views/replay.js';
import { NextUp } from './views/nextup.js';

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

  stateGen: 0, // bumped on every full state (connect, delay change, replay jump)
  replay: null, // replay player info from the server, while a replay plays
  transcripts: new Map(), // radio clip path -> { text, chunks } (made on the laptop)
  transcriptsVer: 0,
  transcriber: null, // speech model status

  /** Replays run without a TV delay: they are not live. */
  effDelay() { return this.status?.mode === 'replay' ? 0 : this.delay; },

  /** "Now" on the data timeline this screen is showing (server clock minus delay; frozen while a replay is paused). */
  playNow() {
    const t = Date.now() + this.clockOffset - this.effDelay() * 1000;
    const r = this.status?.mode === 'replay' ? this.replay : null;
    return r && (r.paused || r.ended) ? Math.min(t, r.at) : t;
  },

  /** Real-world time of what is on screen: in a replay, the time in the recording. */
  dataNow() {
    const r = this.status?.mode === 'replay' ? this.replay : null;
    if (!r) return this.playNow();
    return r.recT + (r.paused || r.ended ? 0 : (Date.now() + this.clockOffset - r.at) * r.speed);
  },

  setReplay(info) { this.replay = info || null; dirty.add('*'); },
  dirty() { dirty.add('*'); },

  setDelay(sec) {
    this.delay = Math.max(0, Math.min(this.maxDelay, Math.round(sec)));
    localStorage.setItem('delay', String(this.delay));
    if (this.status?.mode !== 'replay') { send({ type: 'delay', seconds: this.delay }); this.sentDelay = this.delay; }
    dirty.add('*');
  },
  sync(driver) { send({ type: 'sync', driver }); },

  /**
   * Follow a driver everywhere (tower, map, telemetry, driver panel...).
   * reveal: also bring the Driver panel to the front (double-click, or on a phone).
   */
  select(num, { open = false, reveal = false, toggle = true } = {}) {
    const next = num == null ? null : String(num);
    this.selected = toggle && this.selected === next && !open && !reveal ? null : next;
    if (this.selected) localStorage.setItem('selected', this.selected); else localStorage.removeItem('selected');
    if (this.selected && (open || reveal || layout.mobile)) layout.reveal('driver');
    if (!this.selected && this.map?.follow) this.map.setFollow(false);
    dirty.add('*');
  },

  alerts: localStorage.getItem('driverAlerts') !== '0',
  setAlerts(on) { this.alerts = !!on; localStorage.setItem('driverAlerts', this.alerts ? '1' : '0'); },
  playRadio(path) { radio.toggle(path); },

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

  toast(text, cls = '', onClick = null) {
    const t = document.createElement('div');
    t.className = `toast ${cls}${onClick ? ' clickable' : ''}`;
    t.textContent = text;
    if (onClick) t.addEventListener('click', () => { onClick(); t.remove(); });
    document.getElementById('toasts').append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 280); }, cls ? 9000 : 5000);
  },

  notify(widget) { layout.notify(widget); },
  renderEmpty(el) { nextUp.render(el); },
  hubWanted() { return nextUp.wanted(); },
  hubIdle() { return nextUp.idle(); },
  hubResults() { return nextUp.results(); },
  showTiming: null, // session key whose (finished) timing the user chose to look at
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
store.moment = (text, cls) => moments.note(store.playNow(), store.state, text, cls);
const radar = new Radar(store);
const sheet = new DriverSheet(store);
const history = new LapHistory();
store.history = history;
store.map = map;
const driverPanel = new DriverPanel(store);
const flags = new FlagShow(store);
store.flagShow = (key, label) => flags.show(key, label);
store.lightsOut = () => flags.lightsOut();
const replayBar = new ReplayBar(store);
const nextUp = new NextUp(store);
new Replays(store);
const pace = new Pace(store);
new Settings(store);
const layout = new Layout(store);

const views = [header, tower, map, rc, radio, strategy, telemetry, battles, moments, radar, driverPanel, pace, sheet, replayBar, nextUp];
store.selected = localStorage.getItem('selected') || null;

// Click a driver anywhere to follow them; double-click to open the Driver panel.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-select]');
  if (t) { e.stopPropagation(); store.select(t.dataset.select, { toggle: false }); }
}, true);
document.addEventListener('dblclick', (e) => {
  const t = e.target.closest('[data-select], .tw-row, .car-dot');
  const num = t?.dataset.select || t?.dataset.num;
  if (num) store.select(num, { reveal: true, toggle: false });
});
// Up / down arrows step through the field when following a driver.
document.addEventListener('keydown', (e) => {
  if (!store.selected || e.target.closest('input, textarea, select') || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const order = Object.entries(store.state.TimingData?.Lines || {}).filter(([, l]) => l?.Position).sort((a, b) => a[1].Position - b[1].Position).map(([n]) => n);
  const i = order.indexOf(store.selected);
  const next = order[i + (e.key === 'ArrowUp' ? -1 : 1)];
  if (next) { e.preventDefault(); store.select(next, { toggle: false }); }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // One thing per press: close a menu, else leave single-panel mode, else stop following.
  const open = document.querySelector('.popover:not([hidden]), .menu:not([hidden]), dialog[open], .sheet:not([hidden])');
  if (open) { sheet.close(); for (const id of ['delay-pop', 'layout-pop', 'cols-pop', 'panel-menu']) document.getElementById(id).hidden = true; }
  else if (layout.focus) layout.setFocus(null);
  else if (store.selected) store.select(null);
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
    <div class="pop-sec"><div class="pop-k">Flag changes</div><div class="seg">${[['flag', 'Waving flag'], ['glow', 'Screen glow only'], ['off', 'Off']].map(([v, n]) => `<button data-flaganim="${v}" class="${flags.mode === v ? 'on' : ''}">${n}</button>`).join('')}</div></div>
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
    else if (b.dataset.flaganim) { flags.setMode(b.dataset.flaganim); flags.show('green'); }
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
  store.stateGen++;
  if (Number.isFinite(m.delay)) store.delay = m.delay;
  estimated.reset(store.state, m.at);
  gps.reset();
  telemetry.reset();
  map.reset(store.state);
  if (sessionChanged) { battles.reset(); moments.items = []; }
  moments.reset(store.state, m.at);
  history.onMessage(m.at, '__init', store.state, store.state);
  fetch('/api/history').then((r) => r.json()).then((snap) => { history.load(snap); dirty.add('*'); }).catch(() => {});
  const radioBase = store.state.SessionInfo?.Path;
  if (radioBase) fetch(`/api/transcripts?session=${encodeURIComponent(radioBase)}`).then((r) => r.json()).then((j) => {
    store.transcriber = j.status;
    for (const [k, v] of Object.entries(j.items || {})) store.transcripts.set(k, v);
    store.transcriptsVer++;
    dirty.add('*');
  }).catch(() => {});
  store.clockSeen = { utc: store.state.ExtrapolatedClock?.Utc, t: m.at };
  computeDerived();
  dirty.add('*');
}

function onMsgs(msgs) {
  for (const [t, topic, data] of msgs) {
    applyMessage(store.state, topic, data);
    // Race control also says "RACE START" at lights out: a second trigger for the start lights.
    if (topic === 'RaceControlMessages' && (Array.isArray(data?.Messages) ? data.Messages : Object.values(data?.Messages || {})).some((m) => /^(RACE|SPRINT) START/i.test(m?.Message || ''))) store.lightsOut?.();
    if (topic === 'ExtrapolatedClock') store.clockSeen = { utc: store.state.ExtrapolatedClock?.Utc, t };
    estimated.onMessage(t, topic, data, store.state);
    gps.onMessage(t, topic, data);
    telemetry.onMessage(t, topic, data);
    map.onMessage(t, topic, data);
    rc.onMessage(t, topic, data);
    radio.onMessage(t, topic, data);
    battles.onMessage(t, topic, data, store.state);
    moments.onMessage(t, topic, data, store.state);
    history.onMessage(t, topic, data, store.state);
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
    store.sentDelay = undefined; // a new connection starts at the server's default delay
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
      store.replay = m.replay || null;
      // Replays play with no delay; live and demo use this screen's own delay.
      const want = m.mode === 'replay' ? 0 : store.delay;
      if (Number.isFinite(want) && want !== store.sentDelay) { store.sentDelay = want; send({ type: 'delay', seconds: want }); }
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
    } else if (m.type === 'replay') store.setReplay(m.info);
    else if (m.type === 'transcript') { store.transcripts.set(m.clip, m.entry); store.transcriptsVer++; dirty.add('*'); }
    else if (m.type === 'transcriber') { store.transcriber = m.status; store.transcriptsVer++; dirty.add('*'); }
    else if (m.type === 'toast') store.toast(m.text);
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

// ------------------------------------------------------------------ schedule
fetch('/api/schedule').then((r) => r.json()).then((sch) => { store.schedule = sch; dirty.add('*'); }).catch(() => {});
// Between sessions, notice when an old session goes stale or the next one comes close.
setInterval(() => dirty.add('*'), 30000);
