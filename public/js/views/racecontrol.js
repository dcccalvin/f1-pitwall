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

const isBlue = (m) => m.Category === 'Flag' && m.Flag === 'BLUE';
const linkCars = (text) => esc(text).replace(/\b(\d{1,2}) \(([A-Z]{3})\)/g, '<span class="rc-car" data-select="$1" title="Follow $2">$1 ($2)</span>');

export class RaceControl {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('rc-feed');
    this.count = -1;
    this.open = new Set(); // blue-flag groups the user expanded
    this.blue = document.getElementById('rc-blue');
    this.blue.checked = localStorage.getItem('rcBlue') !== '0';
    this.blue.addEventListener('change', () => { localStorage.setItem('rcBlue', this.blue.checked ? '1' : '0'); this.redraw(); });
    this.root.addEventListener('click', (e) => {
      const g = e.target.closest('[data-group]');
      if (!g || e.target.closest('[data-select]')) return;
      if (this.open.has(g.dataset.group)) this.open.delete(g.dataset.group); else this.open.add(g.dataset.group);
      this.redraw();
    });
  }

  redraw() { this.count = -1; this.update(); }

  list() {
    const raw = this.store.state.RaceControlMessages?.Messages;
    const arr = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean);
    const seen = new Set();
    return arr.filter((m) => { const k = `${m.Utc}|${m.Message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  update() {
    const msgs = this.list();
    if (msgs.length === this.count && this.drawnSel === this.store.selected) return;
    const first = this.count < 0 && !this.drawnOnce;
    this.drawnSel = this.store.selected;
    const fresh = this.count >= 0 ? msgs.length - this.count : 0;
    this.count = msgs.length;
    this.drawnOnce = true;
    const off = this.store.state.SessionInfo?.GmtOffset;
    if (!msgs.length) { this.root.innerHTML = '<div class="feed-empty">No messages from race control yet.</div>'; return; }
    const sel = this.store.selected;
    const mineRe = sel ? new RegExp(String.raw`\b${sel} \([A-Z]{3}\)`) : null;
    const isMine = (m) => !!mineRe && mineRe.test(m.Message || '');

    // Blue flags come in dozens late in a race: runs of them collapse into one line.
    const items = [];
    msgs.slice().reverse().forEach((m, i) => {
      const last = items.at(-1);
      if (isBlue(m) && last?.blue) last.msgs.push({ m, i });
      else items.push(isBlue(m) ? { blue: true, msgs: [{ m, i }] } : { m, i });
    });

    const row = ({ m, i }) => {
      const [cls, label] = classify(m);
      const time = m.Utc ? sessionLocalTime(m.Utc, off) : '';
      return `<div class="rc${i < fresh && !first ? ' fresh' : ''}${isMine(m) ? ' mine' : ''}">
        <div class="rc-time">${m.Lap ? `<b>Lap ${esc(m.Lap)}</b>` : ''}${esc(time)}</div>
        <div class="rc-msg"><span class="chip ${cls}">${esc(label)}</span>${linkCars(m.Message)}</div>
      </div>`;
    };

    const group = (it) => {
      const ms = it.msgs.map((x) => x.m); // newest first
      const key = ms.at(-1).Utc || '';
      const open = this.open.has(key);
      const count = new Map();
      for (const m of ms) {
        const r = /CAR (\d+) \(([A-Z]{3})\)/.exec(m.Message || '');
        if (r) count.set(r[1], { tla: r[2], n: (count.get(r[1])?.n || 0) + 1 });
      }
      const who = [...count.entries()].sort((a, b) => b[1].n - a[1].n)
        .map(([num, c]) => `<span class="rc-car" data-select="${num}" title="Follow ${c.tla}">${c.tla}</span>${c.n > 1 ? ` ×${c.n}` : ''}`).join(', ');
      const lapA = ms.at(-1).Lap, lapB = ms[0].Lap;
      const t1 = sessionLocalTime(ms.at(-1).Utc || '', off).slice(0, 5), t2 = sessionLocalTime(ms[0].Utc || '', off).slice(0, 5);
      const fresh_ = !first && it.msgs.some((x) => x.i < fresh);
      return `<div class="rc rc-group${open ? ' open' : ''}${fresh_ ? ' fresh' : ''}${ms.some(isMine) ? ' mine' : ''}" data-group="${esc(key)}" title="${open ? 'Hide' : 'Show'} each message">
        <div class="rc-time">${lapA ? `<b>Lap ${esc(lapA)}${lapB && lapB !== lapA ? `–${esc(lapB)}` : ''}</b>` : ''}${esc(t1)}${t2 !== t1 ? `–${esc(t2)}` : ''}</div>
        <div class="rc-msg"><span class="chip blue">Blue flags</span><b>${ms.length} blue flags</b> · ${who}<span class="rc-more">${open ? 'Hide' : 'Show all'}</span></div>
      </div>${open ? `<div class="rc-sub">${it.msgs.map(row).join('')}</div>` : ''}`;
    };

    this.root.innerHTML = items.map((it) => {
      if (!it.blue) return row(it);
      if (!this.blue.checked) return '';
      return it.msgs.length === 1 ? row(it.msgs[0]) : group(it);
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
