// Holds the live state plus a rolling history so each screen can watch the data
// with its own delay (to line up with the TV / stream it is watching).
import { applyMessage, clone, INIT } from '../public/js/merge.js';

export const MAX_DELAY_S = 300;
const KEEP_MS = (MAX_DELAY_S + 60) * 1000;
const SNAPSHOT_EVERY_MS = 5000;

export class Timeline {
  constructor() {
    this.state = {};
    this.log = []; // {seq, t, topic, data}
    this.snapshots = []; // {seq, t, state}
    this.seq = 0;
    this.lastSnapshotAt = 0;
  }

  push(topic, data, t = Date.now()) {
    const entry = { seq: ++this.seq, t, topic, data };
    applyMessage(this.state, topic, data);
    this.log.push(entry);
    if (topic === INIT || t - this.lastSnapshotAt >= SNAPSHOT_EVERY_MS) this.#snapshot(t);
    this.#trim(t);
    return entry;
  }

  #snapshot(t) {
    this.snapshots.push({ seq: this.seq, t, state: clone(this.state) });
    this.lastSnapshotAt = t;
  }

  #trim(now) {
    const cutoff = now - KEEP_MS;
    // Always keep at least one snapshot older than the cutoff so the oldest
    // allowed delay can still be rebuilt.
    while (this.snapshots.length > 1 && this.snapshots[1].t <= cutoff) this.snapshots.shift();
    const minSeq = this.snapshots[0]?.seq ?? 0;
    let drop = 0;
    while (drop < this.log.length && this.log[drop].seq <= minSeq) drop++;
    if (drop > 0) this.log.splice(0, drop);
  }

  /** Full state as it was at time `at`, plus the seq it corresponds to. */
  stateAt(at) {
    let snap = this.snapshots[0];
    for (const s of this.snapshots) {
      if (s.t <= at) snap = s;
      else break;
    }
    if (!snap) return { seq: this.seq, state: clone(this.state) };
    const state = clone(snap.state);
    let seq = snap.seq;
    for (const e of this.log) {
      if (e.seq <= snap.seq) continue;
      if (e.t > at) break;
      applyMessage(state, e.topic, e.data);
      seq = e.seq;
    }
    return { seq, state };
  }

  /** Entries after `seq` up to time `at`. */
  since(seq, at) {
    const out = [];
    // log is ordered; find first entry with seq > given seq
    let lo = 0, hi = this.log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.log[mid].seq <= seq) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < this.log.length; i++) {
      const e = this.log[i];
      if (e.t > at) break;
      out.push(e);
    }
    return out;
  }

  /**
   * Time the given driver last completed a lap (from the live head), used by the
   * "Sync" button: the user taps when they see that car cross the line on TV.
   */
  lastLapCrossing(driver) {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i];
      if (e.topic !== 'TimingData') continue;
      const line = e.data?.Lines?.[driver];
      if (line && (line.NumberOfLaps !== undefined || line.LastLapTime?.Value)) return e.t;
    }
    return null;
  }
}
