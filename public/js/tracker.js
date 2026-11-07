// Where is each car on the track?
//
// Free data has no GPS, so EstimatedTracker works it out from timing: every time a
// car passes one of the ~20 timing loops (a mini-sector boundary) we know where it
// is, and between loops we slide it along. With F1 TV, GpsTracker interpolates the
// real X/Y positions instead.
import { parseLap } from './format.js';

// The map is drawn LAG ms behind the timing data so that, almost always, the loop a
// car is heading for has already been crossed: positions are then interpolated
// between two known points (smooth) instead of guessed and corrected (jumpy).
// Loops are ~3 s apart, so ~3.5 s of lag covers the gap.
const LAG = 3500;

export class EstimatedTracker {
  constructor() {
    this.cars = new Map();
    this.secFrac = [0, 1 / 3, 2 / 3, 1];
    this.segCounts = [7, 8, 7];
    this.loops = [];
    this.learned = []; // per loop: { f: learned lap fraction, n: samples }
    this.#buildLoops();
  }

  #buildLoops() {
    const model = [];
    this.segCounts.forEach((n, s) => {
      for (let j = 0; j < n; j++) model.push(this.secFrac[s] + ((this.secFrac[s + 1] - this.secFrac[s]) * (j + 1)) / n);
    });
    if (this.learned.length !== model.length) this.learned = model.map(() => ({ f: 0, n: 0 }));
    // Prefer where real laps show the loops are; keep the order strictly increasing.
    this.loops = model.map((m, k) => (this.learned[k].n >= 2 ? this.learned[k].f : m));
    for (let k = 1; k < this.loops.length; k++) if (this.loops[k] <= this.loops[k - 1]) this.loops[k] = this.loops[k - 1] + 0.002;
    this.loops[this.loops.length - 1] = 1;
  }

  #car(num) {
    let c = this.cars.get(num);
    if (!c) {
      c = { hist: [], inPit: false, segs: new Map(), lapStart: null, passes: [], waitPass: false, dirty: true };
      this.cars.set(num, c);
    }
    return c;
  }

  /** Refresh sector proportions (from best sector times) and loop counts. */
  model(state) {
    const lines = state?.TimingData?.Lines || {};
    const any = Object.values(lines).find((l) => Array.isArray(l?.Sectors) && l.Sectors.length === 3);
    if (any) {
      const counts = any.Sectors.map((s) => (Array.isArray(s?.Segments) ? s.Segments.length : Object.keys(s?.Segments || {}).length) || 1);
      if (counts.join() !== this.segCounts.join()) { this.segCounts = counts; this.learned = []; }
    }
    const best = [Infinity, Infinity, Infinity];
    for (const l of Object.values(state?.TimingStats?.Lines || {})) {
      const bs = l?.BestSectors;
      if (!bs) continue;
      for (let i = 0; i < 3; i++) {
        const v = parseLap(bs[i]?.Value);
        if (v && v < best[i]) best[i] = v;
      }
    }
    if (best.every(isFinite)) {
      const tot = best[0] + best[1] + best[2];
      this.secFrac = [0, best[0] / tot, (best[0] + best[1]) / tot, 1];
    }
    this.#buildLoops();
  }

  loopIndex(sector, seg) {
    let idx = 0;
    for (let s = 0; s < sector; s++) idx += this.segCounts[s];
    return idx + seg;
  }

  loopFrac(sector, seg) {
    return this.loops[this.loopIndex(sector, seg)] ?? 0;
  }

  nextLoop(f) {
    for (const l of this.loops) if (l > f + 1e-6) return l;
    return 1;
  }

  /** Learn where each timing loop really sits, from a clean lap's loop crossing times. */
  #learn(c, tEnd) {
    const t0 = c.lapStart;
    const dur = tEnd - t0;
    if (!t0 || c.dirty || dur < 40000 || dur > 200000 || c.passes.length < this.loops.length * 0.7) return;
    for (const { k, t } of c.passes) {
      const f = (t - t0) / dur;
      const L = this.learned[k];
      if (!L || f <= 0 || f >= 1) continue;
      L.f = L.n ? L.f * 0.75 + f * 0.25 : f;
      L.n++;
    }
    this.#buildLoops();
  }

  /** Record that the car passed lap fraction `frac` at time t, as continuous progress (laps). */
  #anchor(c, t, frac, lapTimeMs) {
    frac = frac >= 0.9999 ? 0 : frac;
    const last = c.hist.at(-1);
    if (!last || t - last.t > 30000) {
      // First sighting, or back after a long gap (garage, red flag): start fresh here.
      c.hist = [{ t, p: (last ? Math.floor(last.p) + 1 : 0) + frac }];
      return;
    }
    const lastF = last.p - Math.floor(last.p);
    const fwd = (((frac - lastF) % 1) + 1) % 1; // distance ahead, wrapping at the line
    // Physically possible in the time since the last loop? (with slack for jitter)
    const maxFwd = Math.min(0.9, ((t - last.t) / lapTimeMs) * 1.6 + 0.06);
    if (fwd === 0 || fwd > maxFwd) return;
    c.hist.push({ t, p: last.p + fwd });
    if (c.hist.length > 12) c.hist.shift();
  }

  /** Seed from a full state (on connect / delay change): last filled loop per car. */
  reset(state, at) {
    this.cars.clear();
    this.model(state);
    for (const [num, l] of Object.entries(state?.TimingData?.Lines || {})) {
      if (!l || typeof l !== 'object') continue;
      const c = this.#car(num);
      c.inPit = !!l.InPit;
      c.waitPass = !!l.InPit || !!l.PitOut;
      let far = null;
      (l.Sectors || []).forEach((sec, s) => {
        const segs = Array.isArray(sec?.Segments) ? sec.Segments : Object.values(sec?.Segments || {});
        segs.forEach((g, j) => {
          c.segs.set(`${s}.${j}`, g?.Status || 0);
          if (g?.Status) { const f = this.loopFrac(s, j); if (far == null || f > far) far = f; }
        });
      });
      if (far != null && !c.waitPass) this.#anchor(c, at - LAG, far, this.#lapTime(num, state) * 1000);
    }
  }

  onMessage(t, topic, data, state) {
    if (topic === 'TimingStats') { this.model(state); return; }
    if (topic !== 'TimingData' || !data?.Lines) return;
    for (const [num, l] of Object.entries(data.Lines)) {
      if (!l || typeof l !== 'object') continue;
      const c = this.#car(num);
      if (l.InPit === true) { c.inPit = true; c.hist = []; c.waitPass = true; c.dirty = true; }
      if (l.InPit === false) c.inPit = false;
      if (l.PitOut === true) { c.waitPass = true; c.dirty = true; }
      // A car passes a timing loop when that mini-sector goes from empty to coloured.
      // F1 also RE-colours segments later (purple -> green when someone else goes
      // faster); those are not passes and must not move the car.
      let far = null, farK = -1;
      if (l.Sectors) {
        for (const [s, sec] of Object.entries(l.Sectors)) {
          if (!sec?.Segments) continue;
          for (const [j, g] of Object.entries(sec.Segments)) {
            const id = `${s}.${j}`;
            const prev = c.segs.get(id) || 0;
            const now = g?.Status || 0;
            c.segs.set(id, now);
            if (!prev && now) {
              const k = this.loopIndex(Number(s), Number(j));
              const f = this.loopFrac(Number(s), Number(j));
              if (far == null || f > far) { far = f; farK = k; }
            }
          }
        }
      }
      // Lap count also ticks when a car leaves the garage in qualifying: that is not a line crossing.
      const lapDone = l.NumberOfLaps !== undefined && !c.inPit && !c.waitPass;
      if (lapDone && far == null) { far = 1; farK = this.loops.length - 1; }
      if (far == null) continue;
      const lapMs = this.#lapTime(num, state) * 1000;
      if (farK === this.loops.length - 1) {
        this.#learn(c, t); // crossing the line: learn loop positions from the lap just done
        c.lapStart = t; c.passes = []; c.dirty = false;
      } else if (farK >= 0) c.passes.push({ k: farK, t });
      if (c.inPit) continue;
      if (c.waitPass) { c.waitPass = false; c.hist = []; } // first loop after leaving the pits: appear here
      this.#anchor(c, t, far, lapMs);
    }
  }

  /** On track and placeable? (hidden in the pits and until the first loop after leaving) */
  visible(num) {
    const c = this.cars.get(num);
    return !!c && !c.inPit && !c.waitPass && c.hist.length > 0;
  }

  /**
   * Continuous progress (laps, e.g. 12.37) of a car at play-time `now`, or null.
   * Interpolates between the timing loops around (now - LAG); only extrapolates
   * (gently, never past the next loop) when the car is late reaching a loop.
   */
  progress(num, now, state, slow = 1) {
    const c = this.cars.get(num);
    if (!c || !c.hist.length) return null;
    const h = c.hist;
    const T = now - LAG;
    if (T <= h[0].t) return h[0].p;
    let i = h.length - 1;
    while (i > 0 && h[i].t > T) i--;
    const a = h[i], b = h[i + 1];
    if (b) return a.p + ((b.p - a.p) * (T - a.t)) / Math.max(1, b.t - a.t);
    const v = this.pace(num, state) / slow; // laps per ms
    const cap = Math.floor(a.p) + this.nextLoop(a.p - Math.floor(a.p));
    const room = Math.max(0, cap - a.p - 0.002);
    const free = v * (T - a.t);
    return a.p + room * (1 - Math.exp(-free / Math.max(room, 1e-6)));
  }

  /** Recent pace in laps/ms: from recent loops, sanity-checked against lap time. */
  pace(num, state) {
    const c = this.cars.get(num);
    const nominal = 1 / (this.#lapTime(num, state) * 1000);
    const h = c?.hist || [];
    if (h.length >= 3) {
      const a = h[h.length - 3], b = h[h.length - 1];
      const v = (b.p - a.p) / Math.max(1, b.t - a.t);
      if (v > nominal * 0.35 && v < nominal * 1.8) return v;
    }
    return nominal;
  }

  #lapTime(num, state) {
    const l = state?.TimingData?.Lines?.[num];
    const last = parseLap(l?.LastLapTime?.Value);
    const best = parseLap(l?.BestLapTime?.Value) || parseLap(l?.BestLapTimes?.[0]?.Value);
    let ref = best || 90;
    if (last && best && last < best * 1.12) ref = last;
    return ref;
  }

  inPit(num) {
    return !!this.cars.get(num)?.inPit;
  }
}

export class GpsTracker {
  constructor() {
    this.samples = new Map(); // num -> [{ts, x, y, status}]
    this.lag = null;
  }

  reset() {
    this.samples.clear();
    this.lag = null;
  }

  get active() {
    return this.samples.size > 0;
  }

  onMessage(t, topic, data) {
    if (topic !== 'Position' || !data?.Position) return;
    let lastTs = 0;
    for (const batch of data.Position) {
      const ts = Date.parse(batch.Timestamp);
      if (isNaN(ts)) continue;
      lastTs = Math.max(lastTs, ts);
      for (const [num, p] of Object.entries(batch.Entries || {})) {
        let arr = this.samples.get(num);
        if (!arr) { arr = []; this.samples.set(num, arr); }
        if (arr.length && arr.at(-1).ts >= ts) continue;
        arr.push({ ts, x: p.X, y: p.Y, status: p.Status });
        if (arr.length > 40) arr.splice(0, arr.length - 40);
      }
    }
    if (lastTs) {
      const lag = t - lastTs;
      this.lag = this.lag == null ? lag : this.lag * 0.9 + lag * 0.1;
    }
  }

  /** Interpolated {x, y, status} at play-time `now` (rendered ~1 batch behind for smoothness). */
  pos(num, now) {
    const arr = this.samples.get(num);
    if (!arr?.length) return null;
    const at = now - (this.lag ?? 0) - 1100;
    if (at <= arr[0].ts) return arr[0];
    for (let i = arr.length - 1; i > 0; i--) {
      if (arr[i - 1].ts <= at) {
        const a = arr[i - 1], b = arr[i];
        if (at >= b.ts) return b;
        const k = (at - a.ts) / (b.ts - a.ts || 1);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, status: b.status };
      }
    }
    return arr.at(-1);
  }
}
