// Penalties from race control, and whether each one has been served yet.
//
// F1 messages look like:
//   "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 14 (ALO) - LEAVING THE TRACK ..."
//   "FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 14 (ALO) - ..."
//   "FIA STEWARDS: 10 SECOND STOP/GO PENALTY FOR CAR 14 (ALO) - ..."
//   "... PENALTY SERVED ..." / "... PENALTY RESCINDED ..."
// Rules used: a time penalty is served at the driver's next pit stop (stationary,
// before work starts) or, if they don't stop again, added to their race time.
// Drive-throughs and stop-go penalties are served on their own pit-lane visit.

const utcMs = (s) => Date.parse(String(s || '').endsWith('Z') ? s : `${s}Z`) || 0;

export function penalties(state, history) {
  const raw = state?.RaceControlMessages?.Messages;
  const msgs = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean);
  const seen = new Set();
  const out = {};
  for (const m of msgs) {
    const text = String(m.Message || '');
    const key = `${m.Utc}|${text}`;
    if (seen.has(key) || !/PENALTY/.test(text)) continue;
    seen.add(key);
    const car = /CAR (\d+)/.exec(text)?.[1];
    if (!car) continue;
    const p = (out[car] ||= { items: [] });
    const at = utcMs(m.Utc);
    if (/SERVED/.test(text)) {
      const open = p.items.find((x) => !x.served);
      if (open) open.served = 'stewards';
      continue;
    }
    if (/RESCINDED|WITHDRAWN|CANCELLED|REVOKED|OVERTURNED/.test(text)) {
      const open = [...p.items].reverse().find((x) => !x.served);
      if (open) open.served = 'withdrawn';
      continue;
    }
    let r;
    if ((r = /(\d+) SECOND TIME PENALTY/.exec(text))) p.items.push({ kind: 'time', secs: Number(r[1]), at, text });
    else if (/DRIVE[- ]THROUGH/.test(text)) p.items.push({ kind: 'dt', secs: 0, at, text });
    else if ((r = /(\d+) SECOND STOP\/GO/.exec(text))) p.items.push({ kind: 'sg', secs: Number(r[1]), at, text });
    // grid drops, reprimands, fines etc. don't affect the live order
  }
  for (const [num, p] of Object.entries(out)) {
    const stops = (history?.laps?.[num] || []).filter((x) => x.pit).map((x) => x.t);
    for (const it of p.items) {
      if (!it.served && stops.some((t) => t > it.at + 5000)) it.served = 'pit';
    }
    const open = p.items.filter((x) => !x.served);
    p.pending = open.filter((x) => x.kind === 'time').reduce((a, x) => a + x.secs, 0);
    p.driveThrough = open.filter((x) => x.kind === 'dt').length;
    p.stopGo = open.filter((x) => x.kind === 'sg').reduce((a, x) => a + x.secs, 0);
    p.any = p.pending > 0 || p.driveThrough > 0 || p.stopGo > 0;
  }
  return out;
}

/** Short badge text, e.g. "+5s", "DT", "SG10", "+5s DT". */
export function penaltyBadge(p) {
  if (!p?.any) return '';
  return [p.pending ? `+${p.pending}s` : '', p.driveThrough ? 'DT' : '', p.stopGo ? `SG${p.stopGo}` : ''].filter(Boolean).join(' ');
}
