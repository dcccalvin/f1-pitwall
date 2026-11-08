// Stewards' investigations, followed through race control's messages:
//   "TURN 5 INCIDENT INVOLVING CAR 44 (HAM) NOTED - LEAVING THE TRACK ... (14:04:04)"
//   "FIA STEWARDS: TURN 5 INCIDENT INVOLVING CAR 44 (HAM) UNDER INVESTIGATION - ... (14:04:04)"
//   "FIA STEWARDS: ... WILL BE INVESTIGATED AFTER THE RACE - ..."
//   "FIA STEWARDS: ... NO FURTHER ACTION - ..." / "... REVIEWED NO FURTHER INVESTIGATION ..."
//   "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 23 (ALB) - REJOINING UNSAFELY (14:50:05)"
// The time in brackets at the end is when the incident happened; it ties the messages
// about one incident together.

const STEP = { noted: 1, investigating: 2, after: 2, cleared: 3, penalty: 3 };
export const STATUS_LABEL = { noted: 'Noted', investigating: 'Under investigation', after: 'After the race', cleared: 'No further action', penalty: 'Penalty' };

const tidy = (s) => String(s || '').replace(/^\s*[-–]\s*/, '').replace(/\s*\(\d{1,2}:\d{2}(:\d{2})?\)\s*$/, '').trim();
const sentence = (s) => { const t = tidy(s).toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : ''; };

/** All incidents so far, oldest first: { key, cars:[{num,tla}], where, reason, status, decision, utc }. */
export function investigations(state) {
  const raw = state?.RaceControlMessages?.Messages;
  const msgs = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter((m) => m?.Message);
  const byKey = new Map();
  for (const m of msgs) {
    const text = String(m.Message);
    if (!/INCIDENT|PENALTY|INVESTIGAT|SUMMONED|REPRIMAND|WARNING|DISQUALIF/.test(text)) continue;
    if (/TRACK LIMITS AT TURN|DELETED/.test(text) && !/INCIDENT/.test(text)) continue; // lap time deletions: counted elsewhere
    const cars = [...text.matchAll(/(?:CARS? |AND )(\d{1,2}) \(([A-Z]{3})\)/g)].map((r) => ({ num: r[1], tla: r[2] }));
    if (!cars.length) continue;
    const at = /\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*$/.exec(text)?.[1] || null;
    let status = null, decision = null;
    if (/WILL BE INVESTIGATED AFTER THE (RACE|SESSION|SPRINT)/.test(text)) status = 'after';
    else if (/UNDER INVESTIGATION|SUMMONED/.test(text)) status = 'investigating';
    else if (/NO FURTHER ACTION|NO FURTHER INVESTIGATION|NO INVESTIGATION NECESSARY|REVIEWED/.test(text)) { status = 'cleared'; decision = 'No further action'; }
    else if (/PENALTY|REPRIMAND|DISQUALIF|WARNING|GRID DROP|STOP\/GO|DRIVE THROUGH/.test(text)) {
      status = 'penalty';
      decision = sentence((/(\d+ SECOND [A-Z ]*PENALTY|\d+ PLACE GRID [A-Z]+|DRIVE THROUGH[A-Z ]*|STOP\/GO[A-Z ]*|REPRIMAND|DISQUALIFIED|BLACK AND WHITE FLAG|WARNING)/.exec(text) || [])[1] || 'Penalty');
    } else if (/NOTED/.test(text)) status = 'noted';
    if (!status) continue;
    const where = /\b(TURN \d+|PIT LANE|PIT ENTRY|PIT EXIT)\b/.exec(text)?.[1] || null;
    const reason = sentence(/(?:NOTED|INVESTIGATION|AFTER THE (?:RACE|SESSION|SPRINT)|NO FURTHER ACTION|NO FURTHER INVESTIGATION|PENALTY FOR CARS? \d+ \([A-Z]{3}\)(?: AND \d+ \([A-Z]{3}\))?)\s*-\s*(.+)$/.exec(text)?.[1] || '');
    const key = at ? `${at}|${cars.map((c) => c.num).sort().join(',')}` : `${cars.map((c) => c.num).sort().join(',')}|${reason}`;
    // A penalty names only the punished car; attach it to the incident at the same time.
    let inc = byKey.get(key) || (at && [...byKey.values()].find((x) => x.at === at && cars.every((c) => x.cars.some((y) => y.num === c.num))));
    if (!inc) {
      inc = { key, at, cars, where, reason, status, decision, utc: m.Utc };
      byKey.set(key, inc);
      continue;
    }
    if (STEP[status] >= STEP[inc.status] || status === 'after') {
      inc.status = status === 'investigating' && inc.status === 'after' ? 'after' : status;
      if (decision) inc.decision = status === 'penalty' && cars.length ? `${decision} for ${cars.map((c) => c.tla).join(', ')}` : decision;
    }
    inc.reason ||= reason;
    inc.where ||= where;
    inc.utc = m.Utc;
  }
  return [...byKey.values()];
}

/** Open cases per car number: { num: [incident, ...] } (noted, under investigation or after the race). */
export function openByCar(list) {
  const out = {};
  for (const inc of list) {
    if (STEP[inc.status] >= 3) continue;
    for (const c of inc.cars) (out[c.num] ||= []).push(inc);
  }
  return out;
}
