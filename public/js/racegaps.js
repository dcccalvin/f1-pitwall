// Race maths shared by the Driver panel (and usable from Node for checking against
// recordings): every car's time behind the leader, and where a car would rejoin
// if it pitted now.
import { gapSeconds } from './history.js';
import { driverOrder, parseLap, stintList } from './format.js';

/**
 * Seconds behind the leader for every running car. F1 gives lapped cars "1L"
 * instead of a time, but the interval to the car ahead is still in seconds, so
 * adding up the intervals down the order gives everyone a time gap.
 */
export function raceGaps(state) {
  const lines = state?.TimingData?.Lines || {};
  const out = {};
  let prev = null;
  let lapTime = null;
  for (const n of driverOrder(state)) {
    const l = lines[n];
    if (!l || l.Retired || l.Stopped) continue;
    if (lapTime == null) lapTime = parseLap(l.LastLapTime?.Value) || parseLap(l.BestLapTime?.Value) || 90;
    let g = Number(l.Position) === 1 ? 0 : gapSeconds(l.GapToLeader);
    if (g == null && prev != null) {
      const ivRaw = String(l.IntervalToPositionAhead?.Value ?? '');
      const iv = gapSeconds(ivRaw);
      const laps = /^\+?(\d+)\s*L/i.exec(ivRaw);
      if (iv != null) g = prev + iv;
      else if (laps) g = prev + Number(laps[1]) * lapTime; // a whole lap behind the car ahead
    }
    out[n] = g;
    if (g != null) prev = g;
  }
  return out;
}

/** Laps done on the current tyres, and whether that stint began with a pit stop. */
function stintAge(state, num) {
  const st = stintList(state, num);
  const cur = st.at(-1);
  if (!cur) return null;
  return { laps: Number(cur.TotalLaps ?? 0) - Number(cur.StartLaps ?? 0), stopped: st.length > 1 };
}

/**
 * Where `num` would rejoin if it pitted now.
 *   loss  seconds a stop costs here (pit lane + stop)
 *   owed  unserved time penalty, served at the stop
 * Returns { pos, front, back, target, wave } where wave (when several cars have just
 * stopped, e.g. for rain or slicks) is { cars, pos }: the rejoin position if the cars
 * ahead that haven't stopped yet come in too.
 */
export function rejoinEstimate(state, num, loss, owed = 0) {
  const lines = state?.TimingData?.Lines || {};
  const gaps = raceGaps(state);
  const myGap = gaps[num];
  if (myGap == null || !isFinite(loss)) return null;
  const target = myGap + loss + owed;
  // A car in the pit lane right now hasn't finished losing its stop's time.
  const inLane = (n) => !!lines[n]?.InPit;
  const now = (n) => gaps[n] + (inLane(n) ? loss * 0.6 : 0);
  let pos = 1, front = null, back = null;
  const recent = [];
  for (const [n, g] of Object.entries(gaps)) {
    if (n === num || g == null) continue;
    const e = now(n);
    if (e < target) { pos++; if (!front || e > front.g) front = { n, g: e }; } else if (!back || e < back.g) back = { n, g: e };
    const a = stintAge(state, n);
    if (inLane(n) || (a?.stopped && a.laps <= 2)) recent.push(n);
  }
  let wave = null;
  if (recent.length >= 3) {
    // Everyone ahead who hasn't just stopped loses a stop too.
    let p2 = 1;
    for (const [n, g] of Object.entries(gaps)) {
      if (n === num || g == null) continue;
      const e = now(n) + (recent.includes(n) ? 0 : loss);
      if (e < target) p2++;
    }
    wave = { cars: recent.length, pos: p2 };
  }
  return { pos, front, back, target, wave };
}
