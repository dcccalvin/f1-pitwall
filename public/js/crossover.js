// Wet / dry crossover: are slicks or intermediates faster right now?
// Compares each car's latest clean lap (no pit stop on it or just before it) from
// the last few minutes, grouped by tyre type, and takes the median of each group.
// Rough by nature (faster cars may be on one type), but it shows the moment the
// first cars on the other tyre start setting quicker laps.
const DRY = new Set(['SOFT', 'MEDIUM', 'HARD']);
const WET = new Set(['INTERMEDIATE', 'WET']);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Are laps on one kind of tyre suddenly getting slower (rain arriving on slicks) or
 * faster (a drying track on inters)? Each car's latest clean lap against its previous
 * clean lap on the same tyre type; the median of those changes per type.
 * Returns { dry: { cars, change }, wet: { cars, change } } (seconds; + = slower), groups
 * with fewer than four cars left out.
 */
export function paceShift(history, until = Infinity, windowMs = 3 * 60000) {
  const ch = { dry: [], wet: [] };
  let now = 0;
  const rows = [];
  for (const num of Object.keys(history?.laps || {})) {
    const laps = history.of(num, until);
    const clean = [];
    for (let i = laps.length - 1; i >= 1 && clean.length < 2 && i >= laps.length - 4; i--) {
      const x = laps[i];
      if (x.time && !x.pit && !laps[i - 1]?.pit && x.comp) clean.push(x);
    }
    if (clean.length < 2 || clean[0].lap - clean[1].lap > 2) continue;
    const type = DRY.has(clean[0].comp) ? 'dry' : WET.has(clean[0].comp) ? 'wet' : null;
    if (!type || (DRY.has(clean[1].comp) ? 'dry' : 'wet') !== type) continue;
    rows.push({ type, t: clean[0].t, change: clean[0].time - clean[1].time });
    now = Math.max(now, clean[0].t);
  }
  for (const r of rows) if (now - r.t < windowMs) ch[r.type].push(r.change);
  const out = {};
  for (const k of ['dry', 'wet']) if (ch[k].length >= 4) out[k] = { cars: ch[k].length, change: median(ch[k]) };
  return out;
}

/**
 * history: LapHistory. until: play-time limit (a delayed screen isn't spoiled).
 * Returns null unless both groups have at least two cars with a recent clean lap, else
 * { dry: { cars, time }, wet: { cars, time }, faster: 'slicks'|'inters', by: seconds }.
 */
export function crossover(history, until = Infinity, windowMs = 4 * 60000) {
  const latest = [];
  for (const num of Object.keys(history?.laps || {})) {
    const laps = history.of(num, until);
    for (let i = laps.length - 1; i >= Math.max(1, laps.length - 3); i--) {
      const x = laps[i];
      if (x.time && !x.pit && !laps[i - 1]?.pit && x.comp) { latest.push({ num, t: x.t, time: x.time, comp: x.comp }); break; }
    }
  }
  if (!latest.length) return null;
  const now = Math.max(...latest.map((x) => x.t));
  const recent = latest.filter((x) => now - x.t < windowMs);
  const dry = recent.filter((x) => DRY.has(x.comp)).map((x) => x.time);
  const wet = recent.filter((x) => WET.has(x.comp)).map((x) => x.time);
  if (dry.length < 2 || wet.length < 2) return null;
  const d = median(dry), w = median(wet);
  return { dry: { cars: dry.length, time: d }, wet: { cars: wet.length, time: w }, faster: d < w ? 'slicks' : 'inters', by: Math.abs(d - w) };
}
