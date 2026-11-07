// Pace: lap times (or, in races, gap to the leader) lap by lap for the selected
// driver and the top five, so you can see who is quicker and whose tyres are fading.
import { esc, teamColor, driverOrder, sessionKind, fmtLap } from '../format.js';

export class Pace {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('pace');
    this.mode = localStorage.getItem('paceMode') || 'laps';
    this.key = '';
    this.root.innerHTML = `
      <div class="pc-bar"><div class="seg pc-mode"><button data-mode="laps">Lap times</button><button data-mode="gap">Gap to leader</button></div><div class="pc-legend"></div></div>
      <div class="pc-chart"><canvas></canvas><div class="pc-empty" hidden></div></div>`;
    this.canvas = this.root.querySelector('canvas');
    this.legend = this.root.querySelector('.pc-legend');
    this.emptyEl = this.root.querySelector('.pc-empty');
    this.root.querySelector('.pc-mode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b || b.disabled) return;
      this.mode = b.dataset.mode;
      localStorage.setItem('paceMode', this.mode);
      this.key = '';
      this.update();
    });
    this.legend.addEventListener('click', (e) => { const b = e.target.closest('[data-num]'); if (b) store.select(b.dataset.num); });
    new ResizeObserver(() => { this.key = ''; this.update(); }).observe(this.root.querySelector('.pc-chart'));
  }

  update() {
    const s = this.store.state;
    const h = this.store.history;
    if (!h || !this.root.offsetWidth) return;
    const kind = sessionKind(s);
    if (kind !== 'race' && this.mode === 'gap') this.mode = 'laps';
    this.root.querySelectorAll('.pc-mode button').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === this.mode);
      b.disabled = b.dataset.mode === 'gap' && kind !== 'race';
      b.title = b.disabled ? 'Gaps are shown during races' : '';
    });
    const order = driverOrder(s).filter((n) => !s.TimingData?.Lines?.[n]?.Retired);
    const sel = this.store.selected;
    const nums = [...new Set([sel, ...order.slice(0, 5)].filter(Boolean))].slice(0, 6);
    const now = this.store.playNow();
    const series = nums.map((n) => ({ n, laps: h.of(n, now) }));
    const key = JSON.stringify([this.mode, sel, nums, h.version, this.canvas.clientWidth, this.canvas.clientHeight, Math.floor(now / 5000), document.body.dataset.theme]);
    if (key === this.key) return;
    this.key = key;
    this.#draw(s, series, sel);
  }

  #draw(s, series, sel) {
    const dl = s.DriverList || {};
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.body);
    const col = (v) => css.getPropertyValue(v).trim();

    // pick values
    const pts = series.map(({ n, laps }) => {
      let p;
      if (this.mode === 'gap') p = laps.filter((x) => x.gap != null).map((x) => [x.lap, x.gap, x.pit]);
      else {
        const times = laps.filter((x) => x.time && !x.pit).map((x) => x.time).sort((a, b) => a - b);
        const med = times[Math.floor(times.length / 2)] || 0;
        // drop out laps, safety-car laps and other slow outliers so the scale stays useful
        p = laps.filter((x) => x.time && !x.pit && x.time < med * 1.07).map((x) => [x.lap, x.time, x.pit]);
      }
      return { n, p };
    });
    const all = pts.flatMap((x) => x.p);
    this.emptyEl.hidden = all.length > 1;
    this.emptyEl.textContent = this.mode === 'gap' ? 'Gaps appear after a few race laps.' : 'Lap times appear as laps are completed.';
    this.legend.innerHTML = series.map(({ n }, i) => {
      const last = pts[i].p.at(-1);
      const v = last ? (this.mode === 'gap' ? (last[1] ? `+${last[1].toFixed(1)}` : 'leader') : fmtLap(last[1])) : '';
      return `<button data-num="${esc(n)}" class="${n === sel ? 'sel' : ''}" style="--tc:${teamColor(dl[n])}"><i></i>${esc(dl[n]?.Tla || n)} <span>${esc(v)}</span></button>`;
    }).join('');
    if (all.length < 2) return;

    const pad = { l: 46, r: 12, t: 12, b: 24 };
    const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]), x0 + 1);
    let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
    if (y1 - y0 < 0.5) { y0 -= 0.25; y1 += 0.25; }
    const X = (v) => pad.l + ((v - x0) / (x1 - x0)) * (W - pad.l - pad.r);
    // lap times: faster at the top; gap: leader (0) at the top
    const Y = (v) => pad.t + ((v - y0) / (y1 - y0)) * (H - pad.t - pad.b);

    g.font = `11px ${col('--font-ui')}`;
    g.fillStyle = col('--text-3');
    g.strokeStyle = col('--line');
    g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = y0 + ((y1 - y0) * k) / 4;
      const y = Y(v);
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
      g.fillText(this.mode === 'gap' ? `+${v.toFixed(y1 - y0 < 6 ? 1 : 0)}s` : fmtLap(v).replace(/\.\d+$/, (m) => m.slice(0, 2)), 4, y + 4);
    }
    const step = Math.max(1, Math.ceil((x1 - x0) / 10));
    for (let lap = Math.ceil(x0); lap <= x1; lap += step) g.fillText(String(lap), X(lap) - 4, H - 6);

    const seen = new Map();
    pts.forEach(({ n, p }) => {
      if (!p.length) return;
      const team = s.DriverList?.[n]?.TeamName;
      const second = seen.has(team); seen.set(team, true);
      const isSel = n === sel;
      g.strokeStyle = teamColor(s.DriverList?.[n]);
      g.fillStyle = g.strokeStyle;
      g.lineWidth = isSel ? 2.6 : 1.4;
      g.globalAlpha = sel && !isSel ? 0.55 : 1;
      g.setLineDash(second ? [5, 4] : []);
      g.beginPath();
      p.forEach(([lap, v], k) => { const x = X(lap), y = Y(v); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
      g.setLineDash([]);
      for (const [lap, v] of p) { g.beginPath(); g.arc(X(lap), Y(v), isSel ? 2.6 : 1.8, 0, Math.PI * 2); g.fill(); }
      g.globalAlpha = 1;
    });
  }
}
