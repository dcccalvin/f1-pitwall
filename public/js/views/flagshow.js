// Track status changes, shown the way a marshal would: a real flag waving on its
// pole (drawn as cloth on a canvas, with folds that catch the light), the screen
// edges lighting up in the flag's colour, and the five red lights at a race start.
//
// Setting (Layout menu): 'flag' = waving flag + glow, 'glow' = glow only, 'off'.

const FLAGS = {
  green: { cloth: '--flag-green', swing: 0.26, rate: 5.6, ms: 3200 },
  yellow: { cloth: '--flag-yellow', swing: 0.3, rate: 6.2, ms: 2600 },
  sc: { cloth: '--flag-yellow', board: 'SC', swing: 0.16, rate: 3.4, ms: 3600 },
  vsc: { cloth: '--flag-yellow', board: 'VSC', swing: 0.16, rate: 3.4, ms: 3600 },
  red: { cloth: '--flag-red', swing: 0.32, rate: 6.2, ms: 3800 },
  chequered: { cloth: 'chequered', swing: 0.4, rate: 6.6, ms: 5200 },
};
const GLOW = { green: '--flag-green', yellow: '--flag-yellow', sc: '--flag-sc', vsc: '--flag-vsc', 'vsc-ending': '--flag-vsc', red: '--flag-red', chequered: '--text' };

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const cssVar = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;

/** The flag's printed cloth, flat, before it is draped. */
function clothTexture(spec, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (spec.cloth === 'chequered') {
    const rows = 6, size = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q * size < w; q++) {
        g.fillStyle = (r + q) % 2 ? '#141414' : '#f2f2f2';
        g.fillRect(Math.floor(q * size), Math.floor(r * size), Math.ceil(size) + 1, Math.ceil(size) + 1);
      }
    }
  } else {
    g.fillStyle = cssVar(spec.cloth, '#ffd400');
    g.fillRect(0, 0, w, h);
  }
  if (spec.board) {
    g.fillStyle = '#121212';
    g.font = `900 ${Math.round(h * (spec.board.length > 2 ? 0.4 : 0.48))}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(spec.board, w * 0.53, h * 0.54);
  }
  // Fabric: a faint weave and a hem along the pole side.
  g.fillStyle = 'rgba(0,0,0,.05)';
  for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
  g.fillStyle = 'rgba(0,0,0,.18)';
  g.fillRect(0, 0, Math.max(3, w * 0.025), h);
  return c;
}

/** A flag on a pole, waved from the bottom of the pole, cloth rippling away from it. */
class ClothFlag {
  constructor(canvas, spec, small) {
    this.spec = spec;
    this.W = small ? 170 : 250;            // cloth size (CSS px)
    this.H = Math.round(this.W * 0.66);
    this.pole = Math.round(this.H * 2.05);  // pole length
    this.cw = this.W + Math.round(this.pole * 0.9);
    this.ch = this.pole + Math.round(this.H * 0.45);
    this.px = Math.round(this.pole * 0.45); // pivot (the marshal's hands)
    this.py = this.ch - 6;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    canvas.width = this.cw * dpr;
    canvas.height = this.ch * dpr;
    canvas.style.width = `${this.cw}px`;
    canvas.style.height = `${this.ch}px`;
    this.ctx = canvas.getContext('2d');
    this.tex = clothTexture(spec, Math.round(this.W * dpr), Math.round(this.H * dpr));
    this.poleColor = '#c8c8c8';
  }

  draw(t) {
    const { ctx, W, H, spec, tex, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    // The pole swings side to side from the hands; the cloth trails behind the swing.
    const ramp = Math.min(1, t / 0.35);
    const swing = spec.swing * ramp * Math.sin(t * spec.rate) + 0.06;
    const swingV = spec.swing * ramp * spec.rate * Math.cos(t * spec.rate);
    ctx.translate(this.px, this.py);
    ctx.rotate(swing);

    // Pole, with a small cap on top.
    const top = -this.pole;
    ctx.fillStyle = this.poleColor;
    ctx.beginPath();
    ctx.roundRect(-2.5, top, 5, this.pole, 2.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillRect(-1.5, top + 4, 1, this.pole - 8);
    ctx.fillStyle = '#e6e6e6';
    ctx.beginPath();
    ctx.arc(0, top - 1, 4, 0, Math.PI * 2);
    ctx.fill();

    // Cloth: thin vertical strips, each lifted by two travelling waves whose size
    // grows away from the pole. Each strip is shaded by its slope, so the folds
    // catch the light and fall into shadow like real fabric.
    const step = 1;
    const k = (Math.PI * 2) / (W * 0.95);
    const w = spec.rate * 1.55 + 3;
    const y0 = top + 4;
    for (let x = 0; x < W; x += step) {
      const u = x / W;
      const env = Math.min(1, u * 1.8) ** 0.9 * (0.55 + 0.45 * u);
      const ph = k * x - w * t;
      const a1 = H * 0.085 * env, a2 = H * 0.035 * env;
      const lag = -swingV * u * u * H * 0.035;  // cloth trails the pole
      const droop = u * u * H * 0.07;            // free end hangs a little
      const dy = a1 * Math.sin(ph) + a2 * Math.sin(2.13 * ph + 1.3) + lag + droop;
      const slope = a1 * k * Math.cos(ph) + a2 * 2.13 * k * Math.cos(2.13 * ph + 1.3);
      const fold = Math.max(-1, Math.min(1, slope * 1.25));
      const squash = 1 - 0.07 * u;               // cloth bunches a little along its length
      const xx = 2.5 + x * squash;
      const hh = H * (1 - 0.07 * Math.abs(fold));
      const yy = y0 + dy + (H - hh) / 2;
      ctx.drawImage(tex, u * tex.width, 0, (step / W) * tex.width, tex.height, xx, yy, step * squash + 0.9, hh);
      ctx.fillStyle = fold > 0 ? `rgba(255,255,255,${(fold * 0.2).toFixed(3)})` : `rgba(0,0,0,${(-fold * 0.42).toFixed(3)})`;
      ctx.fillRect(xx, yy, step * squash + 0.9, hh);
    }
  }
}

export class FlagShow {
  constructor(store) {
    this.store = store;
    this.el = document.getElementById('flagshow');
    this.glowEl = document.getElementById('screenglow');
    const saved = localStorage.getItem('flagAnim');
    this.mode = saved === '0' ? 'off' : saved === 'glow' ? 'glow' : 'flag';
    this.lastYellow = 0;
  }

  get enabled() { return this.mode !== 'off'; }

  setMode(mode) {
    this.mode = ['flag', 'glow', 'off'].includes(mode) ? mode : 'flag';
    localStorage.setItem('flagAnim', this.mode === 'off' ? '0' : this.mode === 'glow' ? 'glow' : '1');
    if (this.mode !== 'flag') this.#hide(true);
  }

  /** Light up the screen edges in the flag's colour. */
  glow(key) {
    const v = GLOW[key];
    if (!v || !this.glowEl) return;
    this.glowEl.style.setProperty('--c', cssVar(v, '#fff'));
    this.glowEl.classList.remove('on');
    void this.glowEl.offsetWidth;
    this.glowEl.classList.add('on');
  }

  show(key) {
    if (!this.enabled) return;
    if (key === 'yellow') { // local yellows come and go a lot: don't nag
      if (Date.now() - this.lastYellow < 45000) return;
      this.lastYellow = Date.now();
    }
    this.glow(key);
    const spec = FLAGS[key];
    if (this.mode !== 'flag' || !spec || reduced()) return;
    this.#hide(true);
    const small = window.innerWidth < 700;
    this.el.innerHTML = '<div class="fs-wrap"><canvas class="fs-canvas"></canvas></div>';
    const flag = new ClothFlag(this.el.querySelector('canvas'), spec, small);
    this.el.hidden = false;
    this.el.className = 'flagshow in';
    const t0 = performance.now();
    const tick = (now) => {
      flag.draw((now - t0) / 1000);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.t1 = setTimeout(() => this.#hide(false), spec.ms);
  }

  /** The five red lights come on one by one, then all go out: the race is on. */
  lightsOut() {
    if (!this.enabled) return;
    if (this.mode !== 'flag' || reduced()) { this.glow('green'); return; }
    this.#hide(true);
    const units = Array.from({ length: 5 }, (_, i) => `<div class="lo-unit" style="--i:${i}"><i></i><i></i></div>`).join('');
    this.el.innerHTML = `<div class="fs-wrap"><div class="lo-gantry">${units}</div></div>`;
    this.el.hidden = false;
    this.el.className = 'flagshow in lights';
    const g = this.el.querySelector('.lo-gantry');
    for (let i = 1; i <= 5; i++) this.timers.push(setTimeout(() => g.classList.add(`on${i}`), 120 + i * 230));
    this.timers.push(setTimeout(() => { g.classList.add('out'); this.glow('green'); }, 1900));
    this.t1 = setTimeout(() => this.#hide(false), 3000);
  }

  timers = [];

  #hide(now) {
    clearTimeout(this.t1); clearTimeout(this.t2);
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const done = () => { cancelAnimationFrame(this.raf); this.el.hidden = true; this.el.className = 'flagshow'; this.el.innerHTML = ''; };
    if (now || this.el.hidden) { done(); return; }
    this.el.classList.add('out');
    this.t2 = setTimeout(done, 450);
  }
}
