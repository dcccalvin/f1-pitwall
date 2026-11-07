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

export function trackState(state) {
  const phase = sessionPhase(state);
  const st = String(state?.TrackStatus?.Status ?? '1');
  if (phase === 'finished') {
    // Qualifying ends Q1 and Q2 with a chequered flag too; the session isn't over yet.
    const part = Number(state?.TimingData?.SessionPart) || 0;
    if (sessionKind(state) === 'quali' && part && part < 3) return { key: 'chequered', label: `Q${part} over · Q${part + 1} next` };
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
    const info = restartInfo(state);
    return { key: 'none', label: info?.kind === 'start' ? `Starts ${info.local}` : 'Not started' };
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
