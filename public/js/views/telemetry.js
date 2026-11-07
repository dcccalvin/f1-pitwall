// Car telemetry (F1 TV only): compare two drivers live — speed, gear, RPM,
// throttle, brake — plus a rolling speed trace. Locked preview on free data.
import { esc, teamColor, driverOrder } from '../format.js';

const WINDOW_MS = 30000;
const CH = { rpm: '0', speed: '2', gear: '3', throttle: '4', brake: '5' };

export class Telemetry {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('telemetry');
    this.lockIcon = document.getElementById('tele-lock');
    this.hist = new Map(); // num -> [{ts, speed, rpm, gear, thr, brk}]
    this.lag = null;
    this.mode = null;
    this.pick = [localStorage.getItem('teleA') || '', localStorage.getItem('teleB') || ''];
    this.frameN = 0;
  }

  get hasData() {
    return this.hist.size > 0;
  }

  reset() {
    this.hist.clear();
    this.lag = null;
  }

  onMessage(t, topic, data) {
    if (topic !== 'CarData' || !data?.Entries) return;
    let lastTs = 0;
    for (const e of data.Entries) {
      const ts = Date.parse(e.Utc);
      if (isNaN(ts)) continue;
      lastTs = Math.max(lastTs, ts);
      for (const [num, c] of Object.entries(e.Cars || {})) {
        const ch = c.Channels || {};
        let arr = this.hist.get(num);
        if (!arr) { arr = []; this.hist.set(num, arr); }
        if (arr.length && arr.at(-1).ts >= ts) continue;
        arr.push({ ts, speed: ch[CH.speed] ?? 0, rpm: ch[CH.rpm] ?? 0, gear: ch[CH.gear] ?? 0, thr: ch[CH.throttle] ?? 0, brk: ch[CH.brake] ?? 0 });
        while (arr.length && arr[0].ts < ts - WINDOW_MS - 15000) arr.shift();
      }
    }
    if (lastTs) {
      const lag = t - lastTs;
      this.lag = this.lag == null ? lag : this.lag * 0.9 + lag * 0.1;
    }
  }

  #locked() {
    const ghost = `
      <div class="ghost">
        <div class="tl-cards">
          ${['VER', 'NOR'].map((t, i) => `<div class="tl-card" style="--tc:${i ? '#F47600' : '#4781D7'}"><div class="who"><b>${t}</b><span>P${i + 1}</span></div>
          <div class="tl-speed">${i ? 287 : 301}<small>km/h</small><span class="tl-gear">${i ? 7 : 8}</span></div>
          <div class="tl-bars"><div class="tl-bar thr">Throttle<div class="track"><i style="width:${i ? 82 : 100}%"></i></div><span class="v">${i ? 82 : 100}%</span></div>
          <div class="tl-bar brk">Brake<div class="track"><i style="width:0"></i></div><span class="v">off</span></div>
          <div class="tl-bar rpm">RPM<div class="track"><i style="width:${i ? 74 : 81}%"></i></div><span class="v">11.6k</span></div></div></div>`).join('')}
        </div>
        <div class="tl-chart" style="margin-top:10px;height:150px"></div>
      </div>
      <div class="lock-card"><div>
        <div class="ico"><svg viewBox="0 0 16 16" width="18" height="18"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7V5.3a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></div>
        <h3>Live car telemetry needs F1 TV</h3>
        <p>F1 only sends car data to signed-in F1 TV accounts. The cheapest plan (F1 TV Access) is enough. It also unlocks:</p>
        <ul><li>Speed, throttle, brake, gear and RPM for every car</li><li>Real GPS positions on the track map</li><li>Pit stop stationary times</li></ul>
        <button class="btn primary" data-open-f1tv>Connect F1 TV</button>
      </div></div>`;
    return `<div class="locked">${ghost}</div>`;
  }

  #layout() {
    this.root.innerHTML = `
      <div class="tl-pickers"><select data-i="0"></select><span class="dim">vs</span><select data-i="1"></select></div>
      <div class="tl-cards">${[0, 1].map((i) => `<div class="tl-card" data-card="${i}"><div class="who"><b>—</b><span></span></div>
        <div class="tl-speed"><span class="sp">0</span><small>km/h</small><span class="tl-gear">N</span></div>
        <div class="tl-bars">
          <div class="tl-bar thr">Throttle<div class="track"><i></i></div><span class="v"></span></div>
          <div class="tl-bar brk">Brake<div class="track"><i></i></div><span class="v"></span></div>
          <div class="tl-bar rpm">RPM<div class="track"><i></i></div><span class="v"></span></div>
        </div></div>`).join('')}</div>
      <div class="tl-chart"><span class="lbl">Speed · last 30s</span><canvas></canvas></div>`;
    this.canvas = this.root.querySelector('canvas');
    this.root.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => {
      this.pick[sel.dataset.i] = sel.value;
      localStorage.setItem(sel.dataset.i === '0' ? 'teleA' : 'teleB', sel.value);
    }));
  }

  update() {
    const f1tv = this.hasData || this.store.status?.f1tv;
    this.lockIcon.hidden = !!f1tv;
    const mode = !f1tv ? 'locked' : this.hasData ? 'live' : 'waiting';
    if (mode !== this.mode) {
      this.mode = mode;
      if (mode === 'locked') this.root.innerHTML = this.#locked();
      else if (mode === 'waiting') this.root.innerHTML = '<div class="feed-empty">F1 TV connected. Waiting for car data (it only flows while cars are on track).</div>';
      else this.#layout();
    }
    if (mode !== 'live') return;

    // driver pickers
    const s = this.store.state;
    const order = driverOrder(s);
    const dl = s.DriverList || {};
    const sel = this.store.selected;
    if (sel !== this.lastSel) { // a driver picked elsewhere (tower/map) becomes driver A
      this.lastSel = sel;
      if (sel && sel !== this.pick[1]) this.pick[0] = sel;
    }
    if (!this.pick[0] || !dl[this.pick[0]]) this.pick[0] = order[0] || '';
    if (!this.pick[1] || !dl[this.pick[1]] || this.pick[1] === this.pick[0]) this.pick[1] = order.find((n) => n !== this.pick[0]) || '';
    const opts = order.map((n) => `<option value="${esc(n)}">${esc(dl[n]?.Tla || n)} · P${esc(s.TimingData?.Lines?.[n]?.Position || '')}</option>`).join('');
    this.root.querySelectorAll('select').forEach((el) => {
      if (el.dataset.opts !== opts) { el.dataset.opts = opts; el.innerHTML = opts; }
      el.value = this.pick[el.dataset.i];
    });
    this.root.querySelectorAll('.tl-card').forEach((card) => {
      const num = this.pick[card.dataset.card];
      const d = dl[num] || {};
      card.style.setProperty('--tc', teamColor(d));
      card.querySelector('.who b').textContent = d.Tla || num;
      card.querySelector('.who span').textContent = `P${s.TimingData?.Lines?.[num]?.Position || '–'} · ${d.TeamName || ''}`;
    });
  }

  #at(num, at) {
    const arr = this.hist.get(num);
    if (!arr?.length) return null;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].ts <= at) return arr[i];
    return arr[0];
  }

  frame(now) {
    if (this.mode !== 'live' || !this.canvas) return;
    if (this.frameN++ % 2) return; // ~30 fps is plenty
    const at = now - (this.lag ?? 0) - 1100;
    const dl = this.store.state.DriverList || {};
    this.root.querySelectorAll('.tl-card').forEach((card) => {
      const v = this.#at(this.pick[card.dataset.card], at);
      if (!v) return;
      card.querySelector('.sp').textContent = Math.round(v.speed);
      card.querySelector('.tl-gear').textContent = v.gear || 'N';
      const bars = card.querySelectorAll('.tl-bar');
      bars[0].querySelector('i').style.width = `${Math.min(100, v.thr)}%`;
      bars[0].querySelector('.v').textContent = `${Math.round(Math.min(100, v.thr))}%`;
      bars[1].querySelector('i').style.width = v.brk ? '100%' : '0';
      bars[1].querySelector('.v').textContent = v.brk ? 'ON' : 'off';
      bars[2].querySelector('i').style.width = `${Math.max(0, Math.min(100, ((v.rpm - 4000) / 9000) * 100))}%`;
      bars[2].querySelector('.v').textContent = `${(v.rpm / 1000).toFixed(1)}k`;
    });
    this.#chart(at, dl);
  }

  #chart(at, dl) {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const top = 26, bottom = h - 22, left = 34, right = w - 10;
    const maxV = 360;
    g.strokeStyle = css.getPropertyValue('--line'); g.fillStyle = css.getPropertyValue('--text-3');
    g.font = `10px ${css.getPropertyValue('--font-num')}`; g.lineWidth = 1;
    for (const v of [100, 200, 300]) {
      const y = bottom - (v / maxV) * (bottom - top);
      g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
      g.fillText(String(v), 6, y + 3);
    }
    this.pick.forEach((num, k) => {
      const arr = this.hist.get(num);
      if (!arr?.length) return;
      const col = teamColor(dl[num]);
      g.strokeStyle = col; g.lineWidth = k === 0 ? 2.2 : 1.6;
      g.setLineDash(k === 0 ? [] : [5, 3]);
      g.beginPath();
      let started = false;
      for (const p of arr) {
        if (p.ts < at - WINDOW_MS || p.ts > at) continue;
        const x = left + ((p.ts - (at - WINDOW_MS)) / WINDOW_MS) * (right - left);
        const y = bottom - (Math.min(maxV, p.speed) / maxV) * (bottom - top);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
      // brake strip
      g.setLineDash([]);
      g.fillStyle = col;
      for (const p of arr) {
        if (p.ts < at - WINDOW_MS || p.ts > at || !p.brk) continue;
        const x = left + ((p.ts - (at - WINDOW_MS)) / WINDOW_MS) * (right - left);
        g.globalAlpha = 0.85; g.fillRect(x - 1.5, h - 16 + k * 7, 3, 5); g.globalAlpha = 1;
      }
    });
    g.fillStyle = css.getPropertyValue('--text-3');
    g.fillText('brake', right - 34, h - 4);
  }
}
