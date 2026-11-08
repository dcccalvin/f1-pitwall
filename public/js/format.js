// Small helpers shared by the views.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "1:13.018" | "28.123" -> seconds */
export function parseLap(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

export function fmtLap(sec) {
  if (sec == null || !isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  return m ? `${m}:${r.toFixed(3).padStart(6, '0')}` : r.toFixed(3);
}

/** "00:23:11" style countdown */
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function parseClock(s) {
  if (!s) return null;
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.reduce((a, v) => a * 60 + v, 0);
}

export const teamColor = (d) => `#${(d?.TeamColour || '7a8590').replace('#', '')}`;

export function sessionKind(state) {
  const info = state?.SessionInfo || {};
  const type = info.Type || '';
  const name = info.Name || '';
  if (type === 'Qualifying' || /qualifying|shootout/i.test(name)) return 'quali';
  if (type === 'Race' || /^sprint$/i.test(name)) return 'race';
  return 'practice';
}

export const TRACK_STATUS = {
  1: { key: 'green', label: 'Track clear' },
  2: { key: 'yellow', label: 'Yellow flag' },
  3: { key: 'green', label: 'Track clear' },
  4: { key: 'sc', label: 'Safety car' },
  5: { key: 'red', label: 'Red flag' },
  6: { key: 'vsc', label: 'Virtual safety car' },
  7: { key: 'vsc-ending', label: 'VSC ending' },
};

const utcMs = (s) => Date.parse(String(s || "").endsWith("Z") ? s : `${s}Z`) || 0;
const rcList = (state) => {
  const raw = state?.RaceControlMessages?.Messages;
  return (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean);
};

/**
 * Where the session is. F1 reuses "Inactive" both before the start and while
 * waiting to restart after a red flag (then SessionStatus.Started is "Started").
 *   pre | running | suspended (red flag) | paused (waiting to restart / between parts) | finished
 */
export function sessionPhase(state) {
  const ss = state?.SessionStatus || {};
  if (['Finished', 'Finalised', 'Ends'].includes(ss.Status)) return 'finished';
  if (ss.Status === 'Aborted') return 'suspended';
  if (ss.Status === 'Inactive' && ss.Started === 'Started') return 'paused';
  if (ss.Status === 'Inactive' || !ss.Status) return 'pre';
  return 'running';
}

/** Was the last stoppage a red flag (vs. a normal break between qualifying parts)? */
function lastStopWasRed(state) {
  const series = state?.SessionData?.StatusSeries;
  const arr = (Array.isArray(series) ? series : Object.values(series || {})).filter((x) => x?.SessionStatus);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].SessionStatus === 'Aborted') return true;
    if (arr[i].SessionStatus === 'Finished') return false;
  }
  return rcList(state).some((m) => m.Flag === 'RED');
}

/** Local track time "16:26" on the session's day -> UTC ms. */
export function trackLocalToUtc(hh, mm, refUtcString, gmtOffset) {
  const m = /^(-)?(\d+):(\d+)/.exec(gmtOffset || '');
  const off = m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const ref = Date.parse(refUtcString?.endsWith?.('Z') ? refUtcString : `${refUtcString}Z`);
  const localDay = new Date((isNaN(ref) ? Date.now() : ref) + off * 60000).toISOString().slice(0, 10);
  return Date.parse(`${localDay}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) - off * 60000;
}

/**
 * Latest restart announcement from race control, e.g. "Q1 WILL RESUME AT 16:26",
 * "RACE WILL RESUME AT 15:40", "QUALIFYING WILL START AT 15:20",
 * or "... WILL NOT RESUME". Only counts if it came after the latest red flag.
 */
export function restartInfo(state) {
  const msgs = rcList(state);
  const off = state?.SessionInfo?.GmtOffset;
  let lastRed = 0;
  for (const m of msgs) if (m.Flag === 'RED') lastRed = Math.max(lastRed, utcMs(m.Utc));
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const text = String(m.Message || '');
    const at = utcMs(m.Utc);
    if (at < lastRed) break;
    if (/WILL NOT (BE )?(RESUM|RESTART)|NOT BE RESUMED|SESSION (IS )?(CANCELLED|ABANDONED)/i.test(text)) return { kind: 'noresume', text };
    const r = /(RESUME|RESTART|START)\w*\s+(?:AT|AROUND)\s+(\d{1,2})[:.](\d{2})/i.exec(text);
    if (r) {
      const kind = /^START/i.test(r[1]) ? 'start' : 'resume';
      return { kind, local: `${r[2].padStart(2, '0')}:${r[3]}`, utc: trackLocalToUtc(r[2], r[3], m.Utc, off), text };
    }
  }
  return null;
}

/** SessionInfo.StartDate is local track time; GmtOffset turns it into UTC ms. */
export function sessionStartUtc(info) {
  if (!info?.StartDate) return null;
  const local = Date.parse(`${String(info.StartDate).slice(0, 19)}Z`);
  if (isNaN(local)) return null;
  const m = /^(-)?(\d+):(\d+)/.exec(info.GmtOffset || '');
  const off = m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return local - off * 60000;
}

/** SessionInfo.EndDate (scheduled end, local track time) as UTC ms. */
export function sessionEndUtc(info) {
  return info?.EndDate ? sessionStartUtc({ StartDate: info.EndDate, GmtOffset: info.GmtOffset }) : null;
}

/**
 * Is this an old, finished session? Between sessions F1's feed keeps sending the
 * last one (e.g. Saturday's qualifying, status "Ends") every time it reconnects.
 * Over = finished and more than an hour past its scheduled end (or "Ends"/"Finalised"
 * with no end time known).
 */
export function sessionOver(state, now = Date.now()) {
  const st = state?.SessionStatus?.Status;
  if (!['Finished', 'Finalised', 'Ends'].includes(st) || state?.SessionInfo?.Replay) return false;
  // Q1 and Q2 also end "Finished"; a long red flag can push them past the scheduled end.
  if (st === 'Finished' && sessionKind(state) === 'quali' && (Number(state?.TimingData?.SessionPart) || 3) < 3) return false;
  const end = sessionEndUtc(state.SessionInfo);
  if (end) return now > end + 60 * 60000;
  return st === 'Ends' || st === 'Finalised';
}

/**
 * Race / sprint start procedure. On F1's free feed a race stays "Inactive" through
 * the formation lap and only becomes "Started" at lights out, so: past the scheduled
 * start but not started = formation lap (unless race control says otherwise).
 * Returns null outside a race's pre-start, else
 *   { stage: 'countdown', to } | { stage: 'formation'|'extra'|'delayed'|'aborted'|'waiting', label, behindSc }
 */
export function startProcedure(state, now = Date.now()) {
  if (sessionKind(state) !== 'race' || sessionPhase(state) !== 'pre') return null;
  const sched = sessionStartUtc(state?.SessionInfo);
  const restart = restartInfo(state); // "FORMATION LAP WILL START AT 14:25"
  if (restart?.kind === 'start' && restart.utc > now) return { stage: 'countdown', to: restart.utc };
  if (!sched) return null;
  if (now < sched) return { stage: 'countdown', to: sched };
  let stage = 'formation', since = sched, behindSc = false;
  for (const m of rcList(state)) {
    const x = String(m.Message || '');
    const at = utcMs(m.Utc);
    if (/EXTRA FORMATION LAP/i.test(x)) { stage = 'extra'; since = at; }
    else if (/START (PROCEDURE )?(HAS BEEN |IS )?ABORTED|ABORTED START/i.test(x)) { stage = 'aborted'; since = at; }
    else if (/START (HAS BEEN |IS )?(DELAYED|POSTPONED|SUSPENDED)|DELAYED START|START PROCEDURE SUSPENDED/i.test(x)) { stage = 'delayed'; since = at; }
    else if (/FORMATION LAP (WILL )?START|FORMATION LAP UNDERWAY/i.test(x) && at >= sched - 60000) { stage = 'formation'; since = at; }
    const announced = /START\w*\s+(?:AT|AROUND)\s+(\d{1,2})[:.](\d{2})/i.exec(x); // "... WILL START AT 14:20"
    if (announced) { stage = 'formation'; since = trackLocalToUtc(announced[1], announced[2], m.Utc, state?.SessionInfo?.GmtOffset); }
    if (/(START|FORMATION LAPS?) BEHIND THE SAFETY CAR|SAFETY CAR START/i.test(x)) behindSc = true;
  }
  // A formation lap takes 2–4 minutes; much longer with no word means a hold-up.
  if ((stage === 'formation' || stage === 'extra') && now - Math.max(sched, since) > 12 * 60000) stage = 'waiting';
  const label = { formation: 'Formation lap', extra: 'Extra formation lap', delayed: 'Start delayed', aborted: 'Start aborted', waiting: 'Waiting for the start' }[stage];
  return { stage, label: behindSc && (stage === 'formation' || stage === 'extra') ? `${label} · behind SC` : label, behindSc };
}

export function trackState(state, now = Date.now()) {
  const phase = sessionPhase(state);
  const st = String(state?.TrackStatus?.Status ?? '1');
  if (phase === 'finished') {
    // Qualifying ends Q1 and Q2 with a chequered flag too; the session isn't over yet.
    const part = Number(state?.TimingData?.SessionPart) || 0;
    const q = /sprint/i.test(state?.SessionInfo?.Name || '') ? 'SQ' : 'Q';
    if (sessionKind(state) === 'quali' && part && part < 3) return { key: 'chequered', label: `${q}${part} over · ${q}${part + 1} next` };
    return { key: 'chequered', label: 'Chequered flag' };
  }
  if (phase === 'suspended') {
    const info = restartInfo(state);
    if (info?.kind === 'noresume') return { key: 'red', label: 'Will not resume' };
    if (info?.kind === 'resume') return { key: 'red', label: `Red flag · resumes ${info.local}` };
    return { key: 'red', label: st === '5' ? 'Red flag · suspended' : 'Session suspended' };
  }
  if (phase === 'paused') {
    const info = restartInfo(state);
    if (info?.kind === 'noresume') return { key: 'red', label: 'Will not resume' };
    if (info) return { key: 'paused', label: `Resumes ${info.local}` };
    return lastStopWasRed(state) ? { key: 'paused', label: 'Suspended' } : { key: 'none', label: 'Break' };
  }
  if (phase === 'pre') {
    // Before the start, still report a flag if race control has one out.
    if (st !== '1' && TRACK_STATUS[st]) return TRACK_STATUS[st];
    const proc = startProcedure(state, now);
    if (proc?.label) return { key: proc.stage === 'aborted' ? 'red' : 'none', label: proc.label };
    const info = restartInfo(state);
    if (info?.kind === 'start') return { key: 'none', label: `Starts ${info.local}` };
    const sched = sessionStartUtc(state?.SessionInfo);
    if (sched && now < sched) return { key: 'none', label: `Starts ${sessionLocalTime(new Date(sched).toISOString(), state.SessionInfo.GmtOffset).slice(0, 5)}` };
    return { key: 'none', label: 'Not started' };
  }
  return TRACK_STATUS[st] || { key: 'none', label: state?.TrackStatus?.Message || '—' };
}

export function segClass(status) {
  if (!status) return '';
  if (status === 2051) return 's-p';
  if (status === 2049) return 's-g';
  if (status === 2064) return 's-pit';
  return 's-y';
}

export function driverOrder(state) {
  const lines = state?.TimingData?.Lines || {};
  return Object.keys(lines)
    .filter((n) => n !== '_kf' && lines[n] && typeof lines[n] === 'object')
    .sort((a, b) => {
      const pa = Number(lines[a].Position) || Number(lines[a].Line) || 99;
      const pb = Number(lines[b].Position) || Number(lines[b].Line) || 99;
      return pa - pb;
    });
}

export function currentStint(state, num) {
  const stints = state?.TimingAppData?.Lines?.[num]?.Stints;
  if (!stints) return null;
  const arr = Array.isArray(stints) ? stints : Object.values(stints);
  return arr.filter(Boolean).at(-1) || null;
}

export function stintList(state, num) {
  const stints = state?.TimingAppData?.Lines?.[num]?.Stints;
  if (!stints) return [];
  return (Array.isArray(stints) ? stints : Object.values(stints)).filter(Boolean);
}

export const compoundLetter = (c) => ({ SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' }[c] || '?');

export function sessionLocalTime(utcString, gmtOffset) {
  // Event-local wall clock (what's on the TV graphics).
  const t = Date.parse(utcString.endsWith('Z') ? utcString : `${utcString}Z`);
  if (isNaN(t)) return '';
  const m = /^(-)?(\d+):(\d+)/.exec(gmtOffset || '');
  const off = m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const d = new Date(t + off * 60000);
  return d.toISOString().slice(11, 19);
}

export function timeAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
