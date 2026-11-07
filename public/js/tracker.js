// Where is each car on the track?
//
// Free data has no GPS, so EstimatedTracker works it out from timing: every time a
// car passes one of the ~20 timing loops (a mini-sector boundary) we know exactly
// where it is, and between loops we advance it at its recent lap pace.
// With F1 TV, GpsTracker interpolates the real X/Y positions instead.
import { parseLap } from './format.js';

export class EstimatedTracker {
  constructor() {
    this.cars = new Map();
    this.secFrac = [0, 1 / 3, 2 / 3, 1];
    this.segCounts = [7, 8, 7];
    this.loops = [];
    this.#buildLoops();
  }

  #buildLoops() {
    this.loops = [];
    this.segCounts.forEach((n, s) => {
      for (let j = 0; j < n; j++) this.loops.push(this.secFrac[s] + ((this.secFrac[s + 1] - this.secFrac[s]) * (j + 1)) / n);
    });
  }

  #car(num) {
    let c = this.cars.get(num);
    if (!c) { c = { anchorT: null, anchorF: 0, inPit: false, display: null }; this.cars.set(num, c); }
    return c;
  }

  /** Refresh sector proportions (from best sector times) and loop counts. */
  model(state) {
    const lines = state?.TimingData?.Lines || {};
    const any = Object.values(lines).find((l) => Array.isArray(l?.Sectors) && l.Sectors.length === 3);
    if (any) {
      const counts = any.Sectors.map((s) => (Array.isArray(s?.Segments) ? s.Segments.length : Object.keys(s?.Segments || {}).length) || 1);
      if (counts.join() !== this.segCounts.join()) this.segCounts = counts;
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

  loopFrac(sector, seg) {
    let idx = 0;
    for (let s = 0; s < sector; s++) idx += this.segCounts[s];
    return this.loops[idx + seg] ?? 0;
  }

  nextLoop(f) {
    for (const l of this.loops) if (l > f + 1e-6) return l;
    return 1;
  }

  /** Seed from a full state (on connect / delay change): last filled loop per car. */
  reset(state, at) {
    this.cars.clear();
    this.model(state);
    for (const [num, l] of Object.entries(state?.TimingData?.Lines || {})) {
      if (!l || typeof l !== 'object') continue;
      const c = this.#car(num);
      c.inPit = !!l.InPit;
      let far = null;
      (l.Sectors || []).forEach((sec, s) => {
        const segs = Array.isArray(sec?.Segments) ? sec.Segments : Object.values(sec?.Segments || {});
        segs.forEach((g, j) => { if (g?.Status) { const f = this.loopFrac(s, j); if (far == null || f > far) far = f; } });
      });
      if (far != null) { c.anchorT = at; c.anchorF = far >= 0.9999 ? 0 : far; }
    }
  }

  onMessage(t, topic, data, state) {
    if (topic === 'TimingStats') { this.model(state); return; }
    if (topic !== 'TimingData' || !data?.Lines) return;
    for (const [num, l] of Object.entries(data.Lines)) {
      if (!l || typeof l !== 'object') continue;
      const c = this.#car(num);
      if (l.InPit !== undefined) c.inPit = !!l.InPit;
      let far = null;
      if (l.Sectors) {
        for (const [s, sec] of Object.entries(l.Sectors)) {
          if (!sec?.Segments) continue;
          for (const [j, g] of Object.entries(sec.Segments)) {
            if (g?.Status) { const f = this.loopFrac(Number(s), Number(j)); if (far == null || f > far) far = f; }
          }
        }
      }
      if (l.NumberOfLaps !== undefined && far == null) far = 1;
      if (far != null) { c.anchorT = t; c.anchorF = far >= 0.9999 ? 0 : far; }
    }
  }

  /** Lap fraction (0..1, time-based) of a car at time `now`, or null. */
  frac(num, now, state, slow = 1) {
    const c = this.cars.get(num);
    if (!c || c.anchorT == null) return null;
    const lapT = this.#lapTime(num, state) * slow;
    let f = c.anchorF + (now - c.anchorT) / 1000 / lapT;
    const cap = this.nextLoop(c.anchorF);
    if (f > cap) f = cap - 0.002; // don't run past a loop we haven't heard about yet
    return ((f % 1) + 1) % 1;
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
