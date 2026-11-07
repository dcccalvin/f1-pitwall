// Track map: circuit outline (MultiViewer's public circuit data) with a dot per car.
// Positions are estimated from timing loops (free) or real GPS (F1 TV).
import { esc, teamColor, driverOrder, trackState } from '../format.js';

const NS = 'http://www.w3.org/2000/svg';
const rad = (d) => (d * Math.PI) / 180;

function rotate(x, y, deg, cx, cy) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  x -= cx; y -= cy;
  return { x: x * c - y * s + cx, y: y * c + x * s + cy };
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class TrackMap {
  constructor(store, estimated, gps) {
    this.store = store;
    this.est = estimated;
    this.gps = gps;
    this.wrap = document.getElementById('map-wrap');
    this.foot = document.getElementById('map-foot');
    this.modeEl = document.getElementById('map-mode');
    this.key = null;
    this.circuit = null;
    this.dots = new Map();
    this.display = new Map(); // num -> smoothed progress (laps)
    this.gone = new Set(); // cars currently faded out (pits, garage)
    this.follow = localStorage.getItem("mapFollow") === "1";
    this.followBtn = document.getElementById("map-follow");
    this.followBtn?.classList.toggle("on", this.follow);
    this.followBtn?.addEventListener("click", () => { if (!store.selected) { store.toast("Pick a driver first: click one in the timing tower or on the map."); return; } this.setFollow(!this.follow); });
    this.flagged = new Map(); // marshal sector -> 'yellow' | 'red'
    this.lastFrame = performance.now();
    this.wrap.addEventListener('click', (e) => {
      const g = e.target.closest('.car-dot');
      if (g) store.select(g.dataset.num);
    });
  }

  async #load(state) {
    const key = state?.SessionInfo?.Meeting?.Circuit?.Key;
    const year = Number(String(state?.SessionInfo?.StartDate || '').slice(0, 4)) || new Date().getFullYear();
    if (!key || `${key}-${year}` === this.key) return;
    this.key = `${key}-${year}`;
    try {
      const r = await fetch(`/api/circuit?key=${key}&year=${year}`);
      if (!r.ok) throw new Error('no outline');
      this.#build(await r.json());
    } catch {
      this.wrap.innerHTML = '<div class="map-placeholder">Circuit outline unavailable</div>';
    }
  }

  #build(c) {
    const cx = (Math.max(...c.x) - Math.min(...c.x)) / 2;
    const cy = (Math.max(...c.y) - Math.min(...c.y)) / 2;
    const rot = (c.rotation || 0) + 90;
    const pts = c.x.map((x, i) => rotate(x, c.y[i], rot, cx, cy));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const size = Math.max(maxX - minX, maxY - minY);
    const pad = size * 0.07;
    const tt = c.trackPositionTime || pts.map((_, i) => i);
    const lapT = tt.at(-1) || 1;
    this.circuit = { raw: c, pts, rot, cx, cy, tt, lapT, size };

    const root = svg('svg', { viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`, preserveAspectRatio: 'xMidYMid meet' });
    const d = `M${pts.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('L')}Z`;
    const w = size * 0.022;
    root.append(svg('path', { d, class: 'trk-edge', 'stroke-width': w * 2.1 }));
    root.append(svg('path', { d, class: 'trk-main', 'stroke-width': w }));

    // marshal sectors (to colour yellow-flag zones)
    this.sectorPaths = new Map();
    const ms = (c.marshalSectors || []).map((m) => ({ n: m.number, i: this.#nearest(rotate(m.trackPosition.x, m.trackPosition.y, rot, cx, cy)) })).sort((a, b) => a.i - b.i);
    ms.forEach((m, k) => {
      const end = ms[(k + 1) % ms.length].i;
      const seg = end > m.i ? pts.slice(m.i, end + 1) : [...pts.slice(m.i), ...pts.slice(0, end + 1)];
      if (seg.length < 2) return;
      const p = svg('path', { d: `M${seg.map((q) => `${q.x.toFixed(0)},${q.y.toFixed(0)}`).join('L')}`, class: 'trk-sector', 'stroke-width': w * 1.15 });
      root.append(p);
      this.sectorPaths.set(m.n, p);
    });

    // finish line
    const a = pts[0], b = pts[1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
    const L = w * 1.6;
    root.append(svg('line', { x1: a.x - Math.cos(ang) * L, y1: a.y - Math.sin(ang) * L, x2: a.x + Math.cos(ang) * L, y2: a.y + Math.sin(ang) * L, class: 'trk-finish', 'stroke-width': w * 0.45 }));

    // corner numbers
    for (const cn of c.corners || []) {
      const off = size * 0.045;
      const p = rotate(cn.trackPosition.x + off * Math.cos(rad(cn.angle)), cn.trackPosition.y + off * Math.sin(rad(cn.angle)), rot, cx, cy);
      const t = svg('text', { x: p.x, y: p.y, class: 'corner', 'font-size': size * 0.03 });
      t.textContent = cn.number;
      root.append(t);
    }

    this.carLayer = svg('g');
    root.append(this.carLayer);
    this.dots.clear();
    this.wrap.innerHTML = '';
    this.wrap.append(root);
    this.svg = root;
    this.fullVB = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2];
    this.vb = null;
    this.#applyFlags();
  }

  #nearest(p) {
    let best = 0, bd = Infinity;
    this.circuit.pts.forEach((q, i) => { const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (dd < bd) { bd = dd; best = i; } });
    return best;
  }

  #pointAt(frac) {
    const { tt, lapT, pts } = this.circuit;
    const t = frac * lapT;
    let lo = 0, hi = tt.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tt[m] <= t) lo = m; else hi = m; }
    const k = (t - tt[lo]) / ((tt[hi] - tt[lo]) || 1);
    return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * k, y: pts[lo].y + (pts[hi].y - pts[lo].y) * k };
  }

  #dot(num, d) {
    let g = this.dots.get(num);
    if (g) return g;
    const r = this.circuit.size * 0.019;
    g = svg('g', { class: 'car-dot', 'data-num': num });
    const halo = svg('circle', { r: r * 1.5, class: 'halo', 'stroke-width': r * 0.28 });
    const circle = svg('circle', { r, fill: teamColor(d), 'stroke-width': r * 0.35 });
    const text = svg('text', { x: r * 1.45, y: r * 0.55, 'font-size': r * 2.1, 'stroke-width': r * 0.55 });
    text.textContent = d?.Tla || num;
    g.append(halo, circle, text);
    this.carLayer.append(g);
    this.dots.set(num, g);
    return g;
  }

  /** Race control messages -> coloured marshal sectors. */
  onMessage(t, topic, data) {
    if (topic !== 'RaceControlMessages') return;
    const msgs = Array.isArray(data?.Messages) ? data.Messages : Object.values(data?.Messages || {});
    for (const m of msgs) this.#flag(m);
    this.#applyFlags();
  }

  reset(state) {
    this.flagged.clear();
    const msgs = state?.RaceControlMessages?.Messages;
    for (const m of (Array.isArray(msgs) ? msgs : Object.values(msgs || {}))) this.#flag(m);
    this.display.clear();
    this.#applyFlags();
  }

  #flag(m) {
    if (!m || m.Category !== 'Flag') return;
    if (m.Scope === 'Track' && (m.Flag === 'GREEN' || m.Flag === 'CLEAR' || m.Flag === 'CHEQUERED')) { this.flagged.clear(); return; }
    if (m.Scope !== 'Sector' || !m.Sector) return;
    if (m.Flag === 'CLEAR') this.flagged.delete(m.Sector);
    else if (/YELLOW/.test(m.Flag)) this.flagged.set(m.Sector, 'yellow');
    else if (m.Flag === 'RED') this.flagged.set(m.Sector, 'red');
  }

  #applyFlags() {
    if (!this.sectorPaths) return;
    for (const [n, p] of this.sectorPaths) p.setAttribute('class', `trk-sector ${this.flagged.get(n) || ''}`);
  }

  update() {
    const s = this.store.state;
    this.#load(s);
    const live = this.gps.active;
    this.modeEl.textContent = live ? 'Live GPS' : 'Estimated positions';
    this.modeEl.classList.toggle('live', live);
    this.modeEl.title = live ? 'Real car positions (F1 TV)' : 'Estimated from timing loops. Connect F1 TV for real GPS positions.';

    // F1's track status is the authority: when it says all clear, no sector is yellow.
    if (trackState(s).key === 'green' && this.flagged.size) { this.flagged.clear(); this.#applyFlags(); }

    const lines = s.TimingData?.Lines || {};
    const inPit = driverOrder(s).filter((n) => lines[n]?.InPit && !lines[n]?.Retired);
    const dl = s.DriverList || {};
    const yellow = [...this.flagged].filter(([, f]) => f === 'yellow').map(([n]) => n).sort((a, b) => a - b);
    const red = [...this.flagged].filter(([, f]) => f === 'red').map(([n]) => n);
    const flagTxt = yellow.length || red.length
      ? `<span class="flaglist${red.length ? ' red' : ''}"><i></i>${red.length ? `Red flag in marshal sector${red.length > 1 ? 's' : ''} ${red.join(', ')}` : `Yellow flag in marshal sector${yellow.length > 1 ? 's' : ''} ${yellow.join(', ')}`}: slow down, no overtaking there</span>`
      : '';
    const txt = flagTxt + (inPit.length ? `<span class="pitlist">In pit lane: <b>${inPit.map((n) => esc(dl[n]?.Tla || n)).join(', ')}</b></span>` : '');
    if (this.foot.dataset.k !== txt) { this.foot.dataset.k = txt; this.foot.innerHTML = txt; }
  }

  frame(now) {
    if (!this.circuit) return;
    const s = this.store.state;
    const dt = Math.min(0.25, (performance.now() - this.lastFrame) / 1000);
    this.lastFrame = performance.now();
    const order = driverOrder(s);
    const lines = s.TimingData?.Lines || {};
    const dl = s.DriverList || {};
    const live = this.gps.active;
    const ts = trackState(s).key;
    const slow = ts === 'sc' ? 1.4 : ts === 'vsc' || ts === 'vsc-ending' ? 1.32 : ts === 'red' ? 50 : 1;
    const seen = new Set();
    const labels = []; // placed label boxes, so crowded labels can be hidden
    const lw = this.circuit.size * 0.075, lh = this.circuit.size * 0.04;
    const sel = this.store.selected;
    const prio = sel && order.includes(sel) ? [sel, ...order.filter((n) => n !== sel)] : order;

    const zoomK = this.#zoomK();
    const dotScale = 1 / zoomK ** 0.65; // dots grow a little when zoomed in, not hugely
    let selPoint = null;

    prio.forEach((num) => {
      const i = order.indexOf(num);
      const l = lines[num];
      if (!l) return;
      let p = null;
      if (live) {
        const g = this.gps.pos(num, now);
        if (g && !(g.x === 0 && g.y === 0) && !(kind(s) !== 'race' && l.InPit)) p = rotate(g.x, g.y, this.circuit.rot, this.circuit.cx, this.circuit.cy);
      } else if (this.est.visible(num) && !l.Retired && !l.Stopped) {
        // Continuous progress in laps (never wraps), so easing never runs the wrong way round.
        const target = this.est.progress(num, now, s, slow);
        if (target != null) {
          let disp = this.display.get(num);
          if (disp == null || this.gone.has(num) || target - disp > 0.35 || disp - target > 0.25) {
            disp = target; // genuinely new position (first sight, back from the pits): place it there
          } else if (target > disp) {
            // Ease towards the target, but never faster than ~2x the car's real pace.
            const vmax = this.est.pace(num, s) * 1000 * 2.2 * dt;
            disp += Math.min((target - disp) * (1 - Math.exp(-dt * 6)), vmax);
          } // target slightly behind: hold still rather than drive backwards
          this.display.set(num, disp);
          p = this.#pointAt(((disp % 1) + 1) % 1);
        }
      }
      const g = this.#dot(num, dl[num]);
      if (!p) { // fade out (pits, garage, retired) and remember it was gone
        if (!this.gone.has(num)) { this.gone.add(num); g.classList.add('gone'); }
        return;
      }
      seen.add(num);
      g.setAttribute('transform', `translate(${p.x.toFixed(0)},${p.y.toFixed(0)}) scale(${dotScale.toFixed(3)})`);
      if (sel === num) selPoint = p;
      const clash = labels.some((b) => Math.abs(b.x - p.x) < lw * dotScale && Math.abs(b.y - p.y) < lh * dotScale);
      if (!clash) labels.push(p);
      const faded = sel && sel !== num && this.follow;
      const cls = `car-dot${i === 0 ? ' leader' : ''}${sel === num ? ' selected' : ''}${l.Retired || l.Stopped ? ' dim' : ''}${clash ? ' nolabel' : ''}${faded ? ' faded' : ''}`;
      if (g.getAttribute('class') !== cls) g.setAttribute('class', cls);
      this.gone.delete(num); // fades back in at its new place
    });
    for (const [num, g] of this.dots) if (!seen.has(num) && !g.classList.contains('gone')) { g.classList.add('gone'); this.gone.add(num); }
    // draw leader & selected on top
    const top = [order[0], this.store.selected].filter((n) => n && this.dots.get(n));
    for (const n of top) if (this.carLayer.lastChild !== this.dots.get(n)) this.carLayer.append(this.dots.get(n));
    this.#camera(selPoint, dt);
  }

  /** Follow mode: glide the view to keep the selected car centred and zoomed in. */
  #camera(p, dt) {
    const full = this.fullVB;
    if (!full) return;
    let target = full;
    if (this.follow && p) {
      const w = this.circuit.size * 0.42;
      const box = this.wrap.getBoundingClientRect();
      const h = box.width ? (w * box.height) / box.width : w;
      target = [p.x - w / 2, p.y - h / 2, w, h];
    }
    const k = 1 - Math.exp(-dt * 3.5);
    this.vb = this.vb ? this.vb.map((v, i) => v + (target[i] - v) * k) : [...full];
    this.svg.setAttribute('viewBox', this.vb.map((v) => v.toFixed(1)).join(' '));
  }

  #zoomK() {
    return this.fullVB && this.vb ? this.fullVB[2] / this.vb[2] : 1;
  }

  setFollow(on) {
    this.follow = !!on;
    localStorage.setItem('mapFollow', this.follow ? '1' : '0');
    this.followBtn?.classList.toggle('on', this.follow);
  }
}

function kind(s) {
  return s?.SessionInfo?.Type === 'Race' ? 'race' : 'other';
}
