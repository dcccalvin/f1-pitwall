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

export function trackState(state) {
  const ss = state?.SessionStatus?.Status;
  if (ss === 'Finished' || ss === 'Finalised' || ss === 'Ends') return { key: 'chequered', label: 'Chequered flag' };
  // Before the start, still report a flag if race control has one out.
  if (ss === 'Inactive' || (!ss && !state?.TrackStatus)) {
    const st = String(state?.TrackStatus?.Status ?? '1');
    return st !== '1' && TRACK_STATUS[st] ? TRACK_STATUS[st] : { key: 'none', label: 'Not started' };
  }
  if (ss === 'Aborted') return { key: 'red', label: 'Session suspended' };
  return TRACK_STATUS[state?.TrackStatus?.Status] || { key: 'none', label: state?.TrackStatus?.Message || '—' };
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
