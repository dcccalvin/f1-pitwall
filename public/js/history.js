// Lap-by-lap history for every driver in the current session, built from the
// timing feed. Shared by the server (which keeps it, and back-fills it from the
// session recording after a restart) and the browser (which keeps it up to date).
//
//   laps[num] = [{ lap, t, time, pb, purple, pit, comp, pos, gap }]
//     lap    lap number completed      t     when (ms, server clock)
//     time   lap time in seconds or null (out laps etc.)
//     pb / purple   personal best / fastest overall at the time
//     pit    the lap included a pit stop or pit exit
//     comp   tyre compound on that lap   pos / gap   position and gap to leader after it

const lapSeconds = (s) => {
  if (!s || typeof s !== 'string') return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s.trim());
  return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : null;
};

export const gapSeconds = (g) => {
  if (g == null || g === '') return null;
  if (/^LAP/i.test(g)) return 0;
  if (/L$/i.test(String(g))) return null; // lapped
  const v = Number(String(g).replace('+', ''));
  return Number.isFinite(v) ? v : null;
};

function compoundNow(state, num) {
  const st = state?.TimingAppData?.Lines?.[num]?.Stints;
  if (!st) return null;
  const arr = (Array.isArray(st) ? st : Object.values(st)).filter(Boolean);
  return arr.at(-1)?.Compound || null;
}

export class LapHistory {
  constructor() {
    this.reset(null);
  }

  reset(sessionKey) {
    this.sessionKey = sessionKey;
    this.laps = {};
    this.pitting = {};
    this.version = 0;
  }

  /** Feed every message after it has been applied to `state`. `topic` '__init' = full state. */
  onMessage(t, topic, data, state) {
    if (topic === '__init') {
      const key = state?.SessionInfo?.Key ?? null;
      if (key !== this.sessionKey) this.reset(key);
      return;
    }
    if (topic !== 'TimingData' || !data?.Lines) return;
    for (const [num, l] of Object.entries(data.Lines)) {
      if (!l || typeof l !== 'object') continue;
      const line = state?.TimingData?.Lines?.[num] || {};
      if (l.InPit === true || l.PitOut === true) this.pitting[num] = true;
      const arr = (this.laps[num] ||= []);
      const lt = l.LastLapTime?.Value;
      if (l.NumberOfLaps !== undefined) {
        const lap = Number(l.NumberOfLaps);
        if (!lap || (arr.length && arr.at(-1).lap >= lap)) continue;
        arr.push({
          lap, t, time: lapSeconds(lt), pb: !!l.LastLapTime?.PersonalFastest, purple: !!l.LastLapTime?.OverallFastest,
          pit: !!this.pitting[num] || !!l.PitOut, comp: compoundNow(state, num),
          pos: Number(line.Position) || null, gap: gapSeconds(line.GapToLeader),
        });
        this.pitting[num] = !!line.InPit;
        this.version++;
      } else if (lt && arr.length && arr.at(-1).time == null && t - arr.at(-1).t < 15000) {
        // The lap time sometimes arrives a moment after the lap count.
        const last = arr.at(-1);
        last.time = lapSeconds(lt);
        last.pb = !!l.LastLapTime?.PersonalFastest;
        last.purple = !!l.LastLapTime?.OverallFastest;
        this.version++;
      }
    }
  }

  snapshot() {
    return { sessionKey: this.sessionKey, laps: this.laps };
  }

  /** Merge a server snapshot (laps we haven't seen yet). */
  load(snap) {
    if (!snap) return;
    if (snap.sessionKey !== this.sessionKey) this.reset(snap.sessionKey);
    for (const [num, list] of Object.entries(snap.laps || {})) {
      const arr = (this.laps[num] ||= []);
      const have = new Set(arr.map((x) => x.lap));
      for (const x of list) if (!have.has(x.lap)) arr.push(x);
      arr.sort((a, b) => a.lap - b.lap);
    }
    this.version++;
  }

  /** Laps of one driver up to play-time `until` (so a delayed screen isn't spoiled). */
  of(num, until = Infinity) {
    return (this.laps[num] || []).filter((x) => x.t <= until);
  }
}
