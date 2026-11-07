// Weather radar around the circuit: the last ~2 hours of rain (RainViewer, every
// 10 min) looping over a street map, with 10/25/50 km rings and the wind.
// Free radar tiles go up to zoom 7; closer zooms stretch the zoom-7 radar.
import { esc } from '../format.js';

const RADAR_MAX_Z = 7;
const TILE = 256;
const FRAME_MS = 650;
const HOLD_MS = 1800;

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };

export class Radar {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('radar');
    this.z = Number(localStorage.getItem('radarZoom')) || 8;
    this.frames = [];
    this.host = '';
    this.idx = 0;
    this.playing = true;
    this.loc = null;
    this.key = '';
    this.root.innerHTML = `
      <div class="rd-map"><div class="rd-base"></div><div class="rd-radar"></div><div class="rd-labels"></div><svg class="rd-rings"></svg><div class="rd-pin"><i></i><span></span></div></div>
      <div class="rd-bar">
        <button class="rd-play" title="Play / pause"></button>
        <input class="rd-scrub" type="range" min="0" max="0" value="0" aria-label="Radar time">
        <span class="rd-time"></span>
        <button class="rd-z" data-z="-1" title="Zoom out">−</button><button class="rd-z" data-z="1" title="Zoom in">+</button>
      </div>
      <div class="rd-foot"><span class="rd-legend"><i></i>Light → heavy rain</span><span class="rd-wind"></span><span class="rd-credit">Radar © RainViewer · Map © Esri, HERE, Garmin, © OpenStreetMap contributors</span></div>
      <div class="rd-msg" hidden></div>`;
    this.mapEl = this.root.querySelector('.rd-map');
    this.baseEl = this.root.querySelector('.rd-base');
    this.radarEl = this.root.querySelector('.rd-radar');
    this.labelsEl = this.root.querySelector('.rd-labels');
    this.ringsEl = this.root.querySelector('.rd-rings');
    this.pinEl = this.root.querySelector('.rd-pin');
    this.playBtn = this.root.querySelector('.rd-play');
    this.scrub = this.root.querySelector('.rd-scrub');
    this.timeEl = this.root.querySelector('.rd-time');
    this.msgEl = this.root.querySelector('.rd-msg');
    this.playBtn.addEventListener('click', () => { this.playing = !this.playing; this.#paintPlay(); });
    this.scrub.addEventListener('input', () => { this.playing = false; this.#paintPlay(); this.#show(Number(this.scrub.value)); });
    this.root.querySelectorAll('.rd-z').forEach((b) => b.addEventListener('click', () => {
      this.z = Math.max(4, Math.min(9, this.z + Number(b.dataset.z)));
      localStorage.setItem('radarZoom', String(this.z));
      this.key = '';
      this.#draw();
    }));
    new ResizeObserver(() => { this.key = ''; this.#draw(); }).observe(this.mapEl);
    this.#paintPlay();
    this.#loadFrames();
    setInterval(() => this.#loadFrames(), 5 * 60000);
    setInterval(() => this.#advance(), FRAME_MS);
  }

  #paintPlay() {
    this.playBtn.innerHTML = this.playing
      ? '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
  }

  async #loadFrames() {
    try {
      const j = await fetch('/api/radar').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
      this.host = j.host;
      const frames = [...(j.radar?.past || []), ...(j.radar?.nowcast || []).map((f) => ({ ...f, forecast: true }))];
      const changed = frames.map((f) => f.path).join() !== this.frames.map((f) => f.path).join();
      this.frames = frames;
      this.scrub.max = String(Math.max(0, frames.length - 1));
      if (changed) { this.idx = frames.length - 1; this.key = ''; this.#draw(); }
      this.msgEl.hidden = true;
    } catch {
      this.msgEl.hidden = false;
      this.msgEl.textContent = 'Radar unavailable right now (no internet, or RainViewer is down).';
    }
  }

  /** Step to the next frame that has finished loading; hold a moment on "now". */
  #advance() {
    if (!this.playing || !this.ready || this.ready.size < 2 || !this.root.isConnected || !this.root.offsetWidth) return;
    const now = performance.now();
    const last = this.frames.length - 1;
    if (this.idx === last && now - (this.heldSince || 0) < HOLD_MS) return;
    let next = this.idx;
    for (let k = 0; k < this.frames.length; k++) { next = (next + 1) % this.frames.length; if (this.ready.has(next)) break; }
    if (next === last) this.heldSince = now;
    this.#show(next);
  }

  /** Circuit location from the season schedule (closest race to this session's date). */
  #location() {
    const s = this.store.state;
    const races = this.store.schedule?.races || [];
    const day = Date.parse(String(s.SessionInfo?.StartDate || '').slice(0, 10)) || Date.now();
    let best = null, bestD = Infinity;
    for (const r of races) {
      if (!isFinite(r.lat) || !isFinite(r.lon)) continue;
      const d = Date.parse(r.date) - day;
      const score = d >= -86400e3 ? d : Math.abs(d) * 3; // prefer this weekend's race (on/after session day)
      if (score < bestD) { bestD = score; best = r; }
    }
    return best;
  }

  update() {
    const loc = this.#location();
    if (loc && (!this.loc || loc.name !== this.loc.name)) { this.loc = loc; this.key = ''; }
    const w = this.store.state.WeatherData;
    const wind = w ? `Wind ${Number(w.WindSpeed).toFixed(1)} m/s from ${compass(Number(w.WindDirection))}` : '';
    const windEl = this.root.querySelector('.rd-wind');
    if (windEl.textContent !== wind) windEl.textContent = wind;
    this.#draw();
  }

  #draw() {
    const W = this.mapEl.clientWidth, H = this.mapEl.clientHeight;
    if (!W || !H) return;
    if (!this.loc) { this.msgEl.hidden = false; this.msgEl.textContent = 'Waiting for the circuit location…'; return; }
    const theme = document.body.dataset.theme === 'paper' ? 'Light' : 'Dark';
    const key = [W, H, this.z, this.loc.name, theme, this.frames.length, this.frames[0]?.path].join('|');
    if (key === this.key) return;
    this.key = key;
    if (this.frames.length) this.msgEl.hidden = true;

    const { lat, lon } = this.loc;
    // base map
    const z = this.z;
    const cx = lonToX(lon, z) * TILE, cy = latToY(lat, z) * TILE;
    const esri = (layer) => (x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${theme}_Gray_${layer}/MapServer/tile/${z}/${y}/${x}`;
    this.baseEl.innerHTML = tiles(z, cx, cy, W, H, TILE, esri('Base'));
    this.labelsEl.innerHTML = tiles(z, cx, cy, W, H, TILE, esri('Reference'));
    // radar frames at the closest supported zoom, stretched if needed
    // RainViewer throttles free use, so ask for few, larger tiles: drop the radar
    // zoom until one frame needs at most ~8 tiles, then stretch it to fit.
    let zr = Math.min(z, RADAR_MAX_Z);
    const count = (zz) => { const sz = TILE * 2 ** (z - zz); return (Math.ceil(W / sz) + 1) * (Math.ceil(H / sz) + 1); };
    while (zr > 3 && count(zr) > 8) zr--;
    const scale = 2 ** (z - zr);
    const rx = lonToX(lon, zr) * TILE * scale, ry = latToY(lat, zr) * TILE * scale;
    this.radarEl.innerHTML = '';
    this.ready = new Set();
    this.loadToken = (this.loadToken || 0) + 1;
    this.frameTiles = (i) => {
      const f = this.frames[i];
      return tiles(zr, rx, ry, W, H, TILE * scale, (x, y) => `${this.host}${f.path}/256/${zr}/${x}/${y}/2/1_1.png`);
    };
    // rings: 10 / 25 / 50 km
    const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
    this.ringsEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.ringsEl.innerHTML = [10, 25, 50].map((km) => {
      const r = (km * 1000) / mPerPx;
      return r < Math.max(W, H) ? `<circle cx="${W / 2}" cy="${H / 2}" r="${r.toFixed(1)}"/><text x="${W / 2 + r * 0.707 + 4}" y="${H / 2 - r * 0.707 - 4}">${km} km</text>` : '';
    }).join('');
    this.pinEl.querySelector('span').textContent = this.loc.circuit || this.loc.locality || '';
    this.#show(this.idx);
    this.#preload(this.loadToken);
  }

  /** Load frames one after another (newest first) so we never flood the tile servers. */
  #preload(token) {
    if (token !== this.loadToken) return;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.ready.has(i)) continue;
      const el = this.#ensure(i);
      const imgs = [...el.querySelectorAll('img')];
      let left = imgs.length;
      const done = () => { if (--left > 0) return; this.ready.add(i); this.#progress(); setTimeout(() => this.#preload(token), 60); };
      if (!left) { this.ready.add(i); continue; }
      for (const img of imgs) { if (img.complete) done(); else { img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }); } }
      return; // one frame at a time
    }
  }

  #progress() {
    const n = this.ready.size, total = this.frames.length;
    this.root.classList.toggle('loading', n < total);
    this.root.querySelector('.rd-legend').dataset.loading = n < total ? `Loading radar ${n}/${total}` : '';
  }

  /** Make sure frame i has its tiles in the page (created on first use). */
  #ensure(i) {
    if (!this.frameTiles || i < 0 || i >= this.frames.length) return null;
    let el = this.radarEl.querySelector(`.rd-frame[data-i="${i}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'rd-frame';
      el.dataset.i = String(i);
      el.innerHTML = this.frameTiles(i);
      this.radarEl.append(el);
    }
    return el;
  }

  #show(i) {
    if (!this.frames.length) return;
    this.idx = Math.max(0, Math.min(this.frames.length - 1, i));
    this.#ensure(this.idx);
    this.radarEl.querySelectorAll('.rd-frame').forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === this.idx));
    this.scrub.value = String(this.idx);
    const f = this.frames[this.idx];
    const t = new Date(f.time * 1000);
    const mins = Math.round((Date.now() - t) / 60000);
    const label = `${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${f.forecast ? 'forecast' : mins <= 10 ? 'latest' : `${mins} min ago`}`;
    if (this.timeEl.textContent !== label) this.timeEl.textContent = label;
  }
}

/** <img> tiles covering a W×H view centred on pixel (cx, cy) of a z-level world. */
function tiles(z, cx, cy, W, H, size, url) {
  const n = 2 ** z;
  const x0 = Math.floor((cx - W / 2) / size), x1 = Math.floor((cx + W / 2) / size);
  const y0 = Math.max(0, Math.floor((cy - H / 2) / size)), y1 = Math.min(n - 1, Math.floor((cy + H / 2) / size));
  let html = '';
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const wx = ((x % n) + n) % n;
      html += `<img src="${esc(url(wx, y))}" alt="" draggable="false" style="left:${Math.round(x * size - cx + W / 2)}px;top:${Math.round(y * size - cy + H / 2)}px;width:${size}px;height:${size}px">`;
    }
  }
  return html;
}

function compass(deg) {
  if (!isFinite(deg)) return '—';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
