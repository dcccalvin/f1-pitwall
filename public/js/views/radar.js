// Weather around the circuit on one timeline:
//   past   last ~2 hours of real rain radar (RainViewer, every 10 min)
//   future next ~2 hours of forecast rain (Open-Meteo, every 15 min, 5×5 grid)
// over a street map with 10/25/50 km rings, plus a plain-words outlook for the circuit.
// (Free radar services stop at "now"; the forecast frames are a weather model, so
// they are smoother and coarser than real radar.)
import { esc, sessionOver } from '../format.js';

const RADAR_MAX_Z = 7;
const TILE = 256;
const FRAME_MS = 700;
const HOLD_MS = 1600;
const FORECAST_STEPS = 8; // 8 × 15 min = 2 hours ahead

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// mm of rain per 15 min -> colour (roughly matching the radar's blue → yellow → red)
function rainColour(mm15) {
  const mmh = mm15 * 4;
  if (mmh < 0.15) return null;
  if (mmh < 1) return [136, 221, 238, 0.5];
  if (mmh < 2.5) return [0, 153, 204, 0.62];
  if (mmh < 5) return [0, 102, 170, 0.7];
  if (mmh < 8) return [255, 220, 0, 0.75];
  if (mmh < 15) return [255, 150, 0, 0.8];
  return [214, 20, 20, 0.85];
}

export class Radar {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('radar');
    this.z = Number(localStorage.getItem('radarZoom')) || 8;
    this.radar = [];      // past frames {time(ms), path}
    this.forecast = null; // Open-Meteo grid
    this.frames = [];     // combined timeline
    this.host = '';
    this.idx = 0;
    this.playing = true;
    this.loc = null;
    this.key = '';
    this.root.innerHTML = `
      <div class="rd-map">
        <div class="rd-base"></div><div class="rd-radar"></div><canvas class="rd-fc"></canvas><div class="rd-labels"></div>
        <svg class="rd-rings"></svg><div class="rd-pin"><i></i><span></span></div>
        <div class="rd-badge" hidden>Forecast</div>
        <div class="rd-zoom"><button class="rd-z" data-z="1" title="Zoom in">+</button><button class="rd-z" data-z="-1" title="Zoom out">−</button></div>
      </div>
      <div class="rd-panel">
        <div class="rd-outlook"><b class="rd-sum">Loading the forecast…</b><span class="rd-chance"></span></div>
        <div class="rd-bars" title="Forecast rain at the circuit, every 15 minutes"></div>
        <div class="rd-bar">
          <button class="rd-play" title="Play / pause"></button>
          <div class="rd-track"><input class="rd-scrub" type="range" min="0" max="0" value="0" aria-label="Time"><div class="rd-ticks"></div></div>
          <span class="rd-time"></span>
        </div>
        <div class="rd-foot"><span class="rd-legend"><i></i>Light → heavy rain</span><span class="rd-wind"></span>
          <span class="rd-credit">Radar © RainViewer · Forecast © Open-Meteo · Map © Esri, HERE, Garmin, © OpenStreetMap contributors</span></div>
      </div>
      <div class="rd-msg" hidden></div>`;
    const $ = (s) => this.root.querySelector(s);
    this.mapEl = $('.rd-map'); this.baseEl = $('.rd-base'); this.radarEl = $('.rd-radar'); this.fcEl = $('.rd-fc');
    this.labelsEl = $('.rd-labels'); this.ringsEl = $('.rd-rings'); this.pinEl = $('.rd-pin'); this.badgeEl = $('.rd-badge');
    this.playBtn = $('.rd-play'); this.scrub = $('.rd-scrub'); this.ticksEl = $('.rd-ticks'); this.timeEl = $('.rd-time');
    this.msgEl = $('.rd-msg'); this.sumEl = $('.rd-sum'); this.chanceEl = $('.rd-chance'); this.barsEl = $('.rd-bars');
    this.playBtn.addEventListener('click', () => { this.playing = !this.playing; this.#paintPlay(); });
    this.scrub.addEventListener('input', () => { this.playing = false; this.#paintPlay(); this.#show(Number(this.scrub.value)); });
    this.root.querySelectorAll('.rd-z').forEach((b) => b.addEventListener('click', () => {
      this.z = Math.max(4, Math.min(10, this.z + Number(b.dataset.z)));
      localStorage.setItem('radarZoom', String(this.z));
      this.key = '';
      this.#draw();
    }));
    new ResizeObserver(() => { this.key = ''; this.#draw(); }).observe(this.mapEl);
    this.#paintPlay();
    this.#loadRadar();
    setInterval(() => this.#loadRadar(), 5 * 60000);
    setInterval(() => this.#loadForecast(), 15 * 60000);
    setInterval(() => this.#advance(), FRAME_MS);
  }

  #paintPlay() {
    this.playBtn.innerHTML = this.playing
      ? '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
  }

  async #loadRadar() {
    try {
      const j = await fetch('/api/radar').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
      this.host = j.host;
      const past = (j.radar?.past || []).map((f) => ({ time: f.time * 1000, path: f.path }));
      if (past.map((f) => f.path).join() !== this.radar.map((f) => f.path).join()) { this.radar = past; this.#rebuild(); }
    } catch {
      this.#message('Radar unavailable right now (no internet, or RainViewer is down). The forecast still works.');
    }
  }

  async #loadForecast() {
    if (!this.loc) return;
    try {
      this.forecast = await fetch(`/api/forecast?lat=${this.loc.lat}&lon=${this.loc.lon}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
      this.#rebuild();
      this.#outlook();
    } catch {
      this.sumEl.textContent = 'Forecast unavailable right now';
    }
  }

  /** One timeline: past radar frames, then forecast frames after the newest radar image. */
  #rebuild() {
    const lastRadar = this.radar.at(-1)?.time || Date.now();
    const fc = (this.forecast?.times || []).map((t, i) => ({ time: Date.parse(t), fc: i }))
      .filter((f) => f.time > lastRadar + 5 * 60000).slice(0, FORECAST_STEPS);
    const wasNow = this.idx === this.#nowIndex();
    this.frames = [...this.radar.map((f, i) => ({ ...f, r: i })), ...fc];
    this.scrub.max = String(Math.max(0, this.frames.length - 1));
    if (wasNow || this.idx >= this.frames.length) this.idx = this.#nowIndex();
    this.#ticks();
    this.key = '';
    this.#draw();
  }

  #nowIndex() {
    let k = 0;
    this.frames.forEach((f, i) => { if (f.r !== undefined) k = i; });
    return k;
  }

  #ticks() {
    if (!this.frames.length) { this.ticksEl.innerHTML = ''; return; }
    const t0 = this.frames[0].time, t1 = this.frames.at(-1).time, now = this.frames[this.#nowIndex()].time;
    const pos = (t) => (this.frames.length < 2 ? 0 : (this.frames.findIndex((f) => f.time >= t) / (this.frames.length - 1)) * 100);
    const marks = [];
    for (const h of [-2, -1, 0, 1, 2]) {
      const t = now + h * 3600e3;
      if (t < t0 - 60000 || t > t1 + 60000) continue;
      marks.push(`<span class="${h === 0 ? 'now' : ''}" style="left:${pos(t)}%">${h === 0 ? 'Now' : `${h > 0 ? '+' : '−'}${Math.abs(h)}h`}</span>`);
    }
    const fcStart = this.frames.findIndex((f) => f.fc !== undefined);
    const fcPct = fcStart > 0 ? ((fcStart - 0.5) / (this.frames.length - 1)) * 100 : 101;
    this.ticksEl.innerHTML = `<i class="rd-fczone" style="left:${fcPct}%"></i>${marks.join('')}`;
  }

  #advance() {
    if (!this.playing || this.frames.length < 2 || !this.root.isConnected || !this.root.offsetWidth) return;
    const now = performance.now();
    const nowIdx = this.#nowIndex();
    if ((this.idx === nowIdx || this.idx === this.frames.length - 1) && now - (this.heldAt || 0) < HOLD_MS) return;
    let next = this.idx;
    for (let k = 0; k < this.frames.length; k++) {
      next = (next + 1) % this.frames.length;
      const f = this.frames[next];
      if (f.fc !== undefined || this.ready?.has(f.r)) break; // only loaded radar frames
    }
    if (next === nowIdx || next === this.frames.length - 1) this.heldAt = now;
    this.#show(next);
  }

  /** Between sessions (an old finished session, or none) the radar shows where the next one is. */
  #idle() {
    const s = this.store.state;
    return this.store.status?.mode === 'live' && (sessionOver(s, this.store.dataNow()) || !Object.keys(s.TimingData?.Lines || {}).length);
  }

  /** Circuit location from the season schedule (closest race to this session's date, or the next one's). */
  #location() {
    const s = this.store.state;
    const races = this.store.schedule?.races || [];
    const next = this.#idle() ? Date.parse(this.store.nextup?.next?.start || '') : NaN;
    const day = (isFinite(next) && next) || Date.parse(String(s.SessionInfo?.StartDate || '').slice(0, 10)) || Date.now();
    let best = null, bestD = Infinity;
    for (const r of races) {
      if (!isFinite(r.lat) || !isFinite(r.lon)) continue;
      const d = Date.parse(r.date) - day;
      const score = d >= -86400e3 ? d : Math.abs(d) * 3; // prefer this weekend's race
      if (score < bestD) { bestD = score; best = r; }
    }
    return best;
  }

  update() {
    const loc = this.#location();
    if (loc && (!this.loc || loc.name !== this.loc.name)) { this.loc = loc; this.key = ''; this.forecast = null; this.#loadForecast(); }
    // Wind comes from the track's weather station: only for the session on now.
    const w = this.#idle() ? null : this.store.state.WeatherData;
    const wind = w ? `Wind ${Number(w.WindSpeed).toFixed(1)} m/s from ${compass(Number(w.WindDirection))}` : '';
    const windEl = this.root.querySelector('.rd-wind');
    if (windEl.textContent !== wind) windEl.textContent = wind;
    if (Date.now() - (this.outlookAt || 0) > 30000) { this.outlookAt = Date.now(); this.#outlook(); }
    this.#draw();
  }

  #message(text) { this.msgEl.hidden = !text; this.msgEl.textContent = text || ''; }

  #draw() {
    const W = this.mapEl.clientWidth, H = this.mapEl.clientHeight;
    if (!W || !H) return;
    if (!this.loc) { this.#message('Waiting for the circuit location…'); return; }
    const theme = document.body.dataset.theme === 'paper' ? 'Light' : 'Dark';
    const key = [W, H, this.z, this.loc.name, theme, this.frames.length, this.radar[0]?.path, this.forecast?.generated].join('|');
    if (key === this.key) return;
    this.key = key;
    this.#message('');
    const { lat, lon } = this.loc;
    const z = this.z;
    this.view = { W, H, z, cx: lonToX(lon, z) * TILE, cy: latToY(lat, z) * TILE };
    const { cx, cy } = this.view;
    const esri = (layer) => (x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${theme}_Gray_${layer}/MapServer/tile/${z}/${y}/${x}`;
    this.baseEl.innerHTML = tiles(z, cx, cy, W, H, TILE, esri('Base'));
    this.labelsEl.innerHTML = tiles(z, cx, cy, W, H, TILE, esri('Reference'));

    // Radar: few, large tiles (RainViewer throttles free use), stretched to fit.
    let zr = Math.min(z, RADAR_MAX_Z);
    const count = (zz) => { const sz = TILE * 2 ** (z - zz); return (Math.ceil(W / sz) + 1) * (Math.ceil(H / sz) + 1); };
    while (zr > 3 && count(zr) > 8) zr--;
    const scale = 2 ** (z - zr);
    const rx = lonToX(lon, zr) * TILE * scale, ry = latToY(lat, zr) * TILE * scale;
    this.radarEl.innerHTML = '';
    this.ready = new Set();
    this.loadToken = (this.loadToken || 0) + 1;
    this.frameTiles = (r) => tiles(zr, rx, ry, W, H, TILE * scale, (x, y) => `${this.host}${this.radar[r].path}/256/${zr}/${x}/${y}/2/1_1.png`);

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

  /** Load radar frames one after another (newest first) so we never flood the tile server. */
  #preload(token) {
    if (token !== this.loadToken) return;
    for (let r = this.radar.length - 1; r >= 0; r--) {
      if (this.ready.has(r)) continue;
      const el = this.#radarFrame(r);
      const imgs = [...el.querySelectorAll('img')];
      let left = imgs.length;
      const done = () => { if (--left > 0) return; this.ready.add(r); this.#progress(); setTimeout(() => this.#preload(token), 60); };
      if (!left) { this.ready.add(r); continue; }
      for (const im of imgs) { if (im.complete) done(); else { im.addEventListener('load', done, { once: true }); im.addEventListener('error', done, { once: true }); } }
      return;
    }
  }

  #progress() {
    const n = this.ready.size, total = this.radar.length;
    this.root.querySelector('.rd-legend').dataset.loading = n < total ? `Loading radar ${n}/${total}` : '';
  }

  #radarFrame(r) {
    let el = this.radarEl.querySelector(`.rd-frame[data-r="${r}"]`);
    if (!el && this.frameTiles) {
      el = document.createElement('div');
      el.className = 'rd-frame';
      el.dataset.r = String(r);
      el.innerHTML = this.frameTiles(r);
      this.radarEl.append(el);
    }
    return el;
  }

  /** Forecast frame: the 5×5 grid drawn as a smooth (bilinear) rain overlay. */
  #drawForecast(fcIndex) {
    const c = this.fcEl, v = this.view, fc = this.forecast;
    const W = v?.W || 0, H = v?.H || 0;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (fcIndex == null || !fc?.precip?.[fcIndex]) return;
    const n = fc.n;
    const small = document.createElement('canvas');
    small.width = n; small.height = n;
    const sg = small.getContext('2d');
    const im = sg.createImageData(n, n);
    fc.precip[fcIndex].forEach((mm, k) => {
      const col = rainColour(mm);
      const o = k * 4;
      if (col) { im.data[o] = col[0]; im.data[o + 1] = col[1]; im.data[o + 2] = col[2]; im.data[o + 3] = Math.round(col[3] * 255); }
    });
    sg.putImageData(im, 0, 0);
    const px = (la, lo) => [lonToX(lo, v.z) * TILE - v.cx + W / 2, latToY(la, v.z) * TILE - v.cy + H / 2];
    const [x0, y0] = px(fc.lats[0], fc.lons[0]);
    const [x1, y1] = px(fc.lats[n * n - 1], fc.lons[n * n - 1]);
    const cw = (x1 - x0) / (n - 1), ch = (y1 - y0) / (n - 1);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.filter = 'blur(6px)';
    g.drawImage(small, x0 - cw / 2, y0 - ch / 2, cw * n, ch * n);
    g.filter = 'none';
    // Fade the edges of the forecast area out instead of ending in a hard square.
    const cxp = (x0 + x1) / 2, cyp = (y0 + y1) / 2, rad = Math.min(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 2;
    const mask = g.createRadialGradient(cxp, cyp, rad * 0.55, cxp, cyp, rad * 1.02);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = mask;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }

  #show(i) {
    if (!this.frames.length) return;
    this.idx = Math.max(0, Math.min(this.frames.length - 1, i));
    const f = this.frames[this.idx];
    const isFc = f.fc !== undefined;
    if (!isFc) this.#radarFrame(f.r);
    this.radarEl.querySelectorAll('.rd-frame').forEach((el) => el.classList.toggle('on', !isFc && Number(el.dataset.r) === f.r));
    this.#drawForecast(isFc ? f.fc : null);
    this.fcEl.classList.toggle('on', isFc);
    this.badgeEl.hidden = !isFc;
    this.scrub.value = String(this.idx);
    const mins = Math.round((f.time - Date.now()) / 60000);
    const label = `${hhmm(f.time)} · ${isFc ? `forecast, in ${mins} min` : -mins <= 12 ? 'latest radar' : `${-mins} min ago`}`;
    if (this.timeEl.textContent !== label) this.timeEl.textContent = label;
    this.root.classList.toggle('is-forecast', isFc);
  }

  /** Plain-words outlook for the circuit, the 15-minute bars and the hourly chance. */
  #outlook() {
    const fc = this.forecast;
    if (!fc?.times?.length) return;
    const mid = Math.floor((fc.n * fc.n) / 2);
    const series = fc.times.map((t, i) => ({ t: Date.parse(t), mmh: (fc.precip[i]?.[mid] || 0) * 4 })).filter((x) => x.t > Date.now() - 15 * 60000);
    const raining = Number(this.store.state.WeatherData?.Rainfall) > 0;
    const wet = series.filter((x) => x.mmh >= 0.2);
    const peak = Math.max(0, ...series.map((x) => x.mmh));
    const nearby = Math.max(0, ...fc.precip.slice(0, series.length).flat()) * 4; // anywhere on the grid
    let text;
    if (!wet.length) text = raining ? 'Raining now, but the forecast shows it clearing' : nearby >= 0.5 ? 'Dry at the circuit · showers nearby in the next 3 hours' : 'Dry at the circuit for the next 3 hours';
    else if (wet[0].t <= Date.now() + 15 * 60000) {
      const dry = series.find((x) => x.t > wet[0].t && x.mmh < 0.2);
      text = `Rain at the circuit now · ${dry ? `easing around ${hhmm(dry.t)}` : 'continuing for the next few hours'}`;
    } else text = `Rain likely from about ${hhmm(wet[0].t)} · up to ${peak.toFixed(1)} mm/h`;
    this.sumEl.textContent = text;
    const ch = (fc.chance || []).filter((x) => x.p != null && Date.parse(x.t) > Date.now() - 3600e3).slice(0, 4);
    this.chanceEl.innerHTML = ch.length ? `Chance of rain ${ch.map((x) => `<b>${x.p}%</b> ${hhmm(Date.parse(x.t))}`).join(' · ')}` : '';
    const max = Math.max(2, peak);
    this.barsEl.innerHTML = series.map((x) => {
      const h = x.mmh < 0.1 ? 2 : Math.max(4, (x.mmh / max) * 100);
      const col = rainColour(x.mmh / 4);
      return `<span title="${hhmm(x.t)}: ${x.mmh.toFixed(1)} mm/h"><i style="height:${h}%;${col ? `background:rgba(${col.slice(0, 3)},1)` : ''}"></i><em>${hhmm(x.t)}</em></span>`;
    }).join('');
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
