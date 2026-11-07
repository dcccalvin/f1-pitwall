// Race control messages, newest first, with flag/penalty chips and toasts for big moments.
import { esc, sessionLocalTime, trackLocalToUtc } from '../format.js';

function classify(m) {
  const msg = m.Message || '';
  if (m.Category === 'Flag') {
    const f = m.Flag || '';
    if (f === 'GREEN') return ['green', 'Green'];
    if (f === 'CLEAR') return ['', 'Clear'];
    if (f === 'DOUBLE YELLOW') return ['yellow', 'Double yellow'];
    if (f === 'YELLOW') return ['yellow', 'Yellow'];
    if (f === 'RED') return ['red', 'Red flag'];
    if (f === 'BLUE') return ['blue', 'Blue'];
    if (f === 'CHEQUERED') return ['chequered', 'Chequered'];
    if (f === 'BLACK AND WHITE') return ['', 'Black/white'];
    return ['', f || 'Flag'];
  }
  if (m.Category === 'SafetyCar' || /SAFETY CAR/.test(msg)) return ['sc', /VIRTUAL/.test(msg) || m.Mode === 'VIRTUAL SAFETY CAR' ? 'VSC' : 'Safety car'];
  if (/PENALTY|DISQUALIF|DRIVE THROUGH|STOP\/GO|GRID DROP/.test(msg)) return ['penalty', 'Penalty'];
  if (/INVESTIGAT|NOTED|REVIEWED|SUMMONED/.test(msg)) return ['investigation', 'Stewards'];
  if (/DELETED|TRACK LIMITS/.test(msg)) return ['limits', 'Track limits'];
  if (/RAIN|WET/.test(msg)) return ['blue', 'Weather'];
  if (/PIT EXIT|PIT ENTRY/.test(msg)) return ['', 'Pit lane'];
  if (/WILL (RESUME|RESTART|START)|WILL NOT RESUME/.test(msg)) return ['resume', 'Restart'];
  return ['', 'Info'];
}

export class RaceControl {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('rc-feed');
    this.count = -1;
  }

  list() {
    const raw = this.store.state.RaceControlMessages?.Messages;
    const arr = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean);
    const seen = new Set();
    return arr.filter((m) => { const k = `${m.Utc}|${m.Message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  update() {
    const msgs = this.list();
    if (msgs.length === this.count) return;
    const fresh = this.count >= 0 ? msgs.length - this.count : 0;
    this.count = msgs.length;
    const off = this.store.state.SessionInfo?.GmtOffset;
    if (!msgs.length) { this.root.innerHTML = '<div class="feed-empty">No messages from race control yet.</div>'; return; }
    this.root.innerHTML = msgs.slice().reverse().map((m, i) => {
      const [cls, label] = classify(m);
      const time = m.Utc ? sessionLocalTime(m.Utc, off) : '';
      return `<div class="rc${i < fresh ? ' fresh' : ''}">
        <div class="rc-time">${m.Lap ? `<b>Lap ${esc(m.Lap)}</b>` : ''}${esc(time)}</div>
        <div class="rc-msg"><span class="chip ${cls}">${esc(label)}</span>${esc(m.Message)}</div>
      </div>`;
    }).join('');
    if (fresh > 0) this.store.notify('control');
  }

  /** Called for live messages only (not on reconnect) so toasts don't replay. */
  onMessage(t, topic, data) {
    if (topic !== 'RaceControlMessages') return;
    const msgs = Array.isArray(data?.Messages) ? data.Messages : Object.values(data?.Messages || {});
    for (const m of msgs) {
      if (!m) continue;
      // "Q1 WILL RESUME AT 16:26": also say when that is for the viewer.
      const r = /(RESUME|RESTART|START)\w*\s+(?:AT|AROUND)\s+(\d{1,2})[:.](\d{2})/i.exec(m.Message || '');
      if (r) {
        const utc = trackLocalToUtc(r[2], r[3], m.Utc, this.store.state.SessionInfo?.GmtOffset);
        const yours = new Date(utc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.store.toast(`${m.Message} track time (${yours} your time)`, 'resume');
        continue;
      }
      const [cls, label] = classify(m);
      if (cls === 'sc' || cls === 'red' || cls === 'penalty' || cls === 'chequered') {
        this.store.toast(`${label}: ${m.Message}`, cls === 'chequered' ? '' : cls);
      }
    }
  }
}
