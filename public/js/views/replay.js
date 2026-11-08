// Replays: a list of saved sessions to pick from, and a player bar (play / pause,
// speed, a timeline with the key moments marked) while one is playing.
import { esc, fmtClock, sessionLocalTime } from '../format.js';

const PLAY = '<svg viewBox="0 0 16 16"><path d="M4.5 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';
const AGAIN = '<svg viewBox="0 0 16 16"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LIST = '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const SPEEDS = [1, 2, 5, 10, 30];

const isRace = (m) => /race|sprint$/i.test(m?.session || '') && !/qualifying|shootout/i.test(m?.session || '');

/** What each mark on the timeline means, in words. */
export function markLabels(meta) {
  let starts = 0;
  return (meta?.marks || []).map((m) => {
    const label = m.kind === 'start' ? (starts++ === 0 ? (isRace(meta) ? 'Lights out' : 'Session start') : 'Restart')
      : { red: 'Red flag', sc: 'Safety car', vsc: 'Virtual safety car', end: 'Chequered flag' }[m.kind] || m.kind;
    return { ...m, label };
  });
}

const trackTime = (meta, sec) => (meta?.recordedAt ? sessionLocalTime(new Date(meta.recordedAt + sec * 1000).toISOString(), meta.gmtOffset).slice(0, 5) : '');
const dur = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
};

async function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json()).catch(() => ({ error: 'Pit Wall is not reachable' }));
}

/** The list of saved sessions. */
export class Replays {
  constructor(store) {
    this.store = store;
    this.dlg = document.getElementById('replays');
    this.body = document.getElementById('replays-body');
    this.dlg.addEventListener('click', (e) => { if (e.target === this.dlg) this.dlg.close(); });
    this.body.addEventListener('click', (e) => this.#onClick(e));
    document.addEventListener('click', (e) => { if (e.target.closest('[data-open-replays]')) this.open(); });
  }

  async open() {
    const settings = document.getElementById('settings');
    if (settings?.open) settings.close();
    this.body.innerHTML = '<p class="muted" style="padding:20px 0">Loading…</p>';
    if (!this.dlg.open) this.dlg.showModal();
    const r = await fetch('/api/recordings').then((x) => x.json()).catch(() => ({ files: [] }));
    this.canSwitch = !!r.canSwitch;
    this.#render(r.files || [], r.mode);
  }

  #render(files, mode) {
    const cur = this.store.replay?.file;
    const can = this.canSwitch;
    const real = files.filter((f) => !f.broken && !f.demo);
    const groups = new Map();
    for (const f of real) {
      const k = `${f.meeting || 'Other'}|${(f.startDate || '').slice(0, 4)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    const item = (f) => {
      const labels = markLabels(f);
      const counts = {};
      for (const m of labels) if (m.kind !== 'start' || m.label !== 'Restart') counts[m.label] = (counts[m.label] || 0) + 1;
      const day = f.startDate ? new Date(`${f.startDate.slice(0, 10)}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '';
      const moments = Object.entries(counts).map(([label, n]) => {
        const kind = labels.find((m) => m.label === label)?.kind;
        return `<span class="m-${kind}"><i></i>${esc(label)}${n > 1 ? ` ×${n}` : ''}</span>`;
      }).join('');
      return `<div class="rp-item${cur === f.name ? ' cur' : ''}">
        <div class="rp-main"><b>${esc(f.session)}${f.recording ? '<span class="tag">Recording now</span>' : ''}${cur === f.name ? '<span class="tag ok">Playing</span>' : ''}</b>
          <div class="rp-sub">${esc([f.circuit, day, f.dur ? dur(f.dur) : ''].filter(Boolean).join(' · '))}</div>
          ${moments ? `<div class="rp-moments">${moments}</div>` : ''}</div>
        <button type="button" class="btn primary" data-play="${esc(f.name)}" ${can ? '' : 'disabled'}>${PLAY}<span>Play</span></button>
      </div>`;
    };
    this.body.innerHTML = `
      ${mode !== 'live' ? `<div class="rp-now"><span>${mode === 'replay' ? 'You are watching a replay.' : 'You are watching the demo race.'}</span><button type="button" class="btn primary" data-live ${can ? '' : 'disabled'}>Back to live timing</button></div>` : ''}
      <p class="rp-intro">Every session Pit Wall shows live is saved on this laptop. Watch one again with everything: timing, track map, radio, race control. The bar at the bottom pauses, speeds up, and jumps straight to the start, red flags or safety cars.</p>
      ${can ? '' : '<p class="muted">Start a replay on the laptop running Pit Wall. Once it is playing you can pause and skip from this screen too.</p>'}
      ${groups.size ? [...groups.entries()].map(([k, list]) => `<div class="rp-group">${esc(k.split('|')[0])} ${esc(k.split('|')[1])}</div>${list.map(item).join('')}`).join('')
        : '<p class="rp-empty">Nothing saved yet. Sessions are saved automatically while Pit Wall shows live timing.</p>'}
      <div class="rp-group">Practice</div>
      <div class="rp-item"><div class="rp-main"><b>Demo race</b><div class="rp-sub">A simulated 40-lap race with a safety car, pit stops, penalties and team radio</div></div>
        <button type="button" class="btn" data-demo ${can ? '' : 'disabled'}>${PLAY}<span>Play</span></button></div>`;
  }

  async #onClick(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    let body = null, msg = '';
    if (b.dataset.play) { body = { mode: 'replay', file: b.dataset.play }; msg = 'Replay started · use the bar at the bottom to pause, speed up or jump'; }
    else if (b.hasAttribute('data-demo')) { body = { mode: 'demo' }; msg = 'Demo race started'; }
    else if (b.hasAttribute('data-live')) { body = { mode: 'live' }; msg = 'Back to live timing'; }
    if (!body) return;
    b.disabled = true;
    const r = await post('/api/mode', body);
    if (r.error) { this.store.toast(r.error); b.disabled = false; return; }
    this.dlg.close();
    this.store.toast(msg, 'ok');
  }
}

/** Player bar shown while a replay is playing. */
export class ReplayBar {
  constructor(store) {
    this.store = store;
    this.el = document.getElementById('replaybar');
    this.drawn = '';
    this.dragging = false;
    this.el.addEventListener('click', (e) => this.#onClick(e));
    this.el.addEventListener('input', (e) => {
      if (!e.target.matches('.rb-range')) return;
      this.dragging = true;
      this.#hover(Number(e.target.value));
      this.#paint(Number(e.target.value));
    });
    this.el.addEventListener('change', (e) => {
      if (!e.target.matches('.rb-range')) return;
      this.dragging = false;
      this.#hover(null);
      this.#send('seek', Number(e.target.value));
    });
    this.el.addEventListener('pointermove', (e) => {
      const scrub = e.target.closest('.rb-scrub');
      if (!scrub || this.dragging) return;
      const r = scrub.getBoundingClientRect();
      const mark = e.target.closest('.rb-mark');
      this.#hover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (this.meta?.dur || 0), mark?.dataset.label);
    });
    this.el.addEventListener('pointerleave', () => { if (!this.dragging) this.#hover(null); });
    // Space bar = play / pause while replaying (not when typing).
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || !this.meta || e.target.closest('input, textarea, select, button, [contenteditable]')) return;
      e.preventDefault();
      this.#send(this.meta.paused || this.meta.ended ? 'play' : 'pause');
    });
  }

  async #send(action, value) {
    const r = await post('/api/replay', { action, value });
    if (r.error) this.store.toast(r.error);
    else this.store.setReplay(r);
  }

  #onClick(e) {
    const mark = e.target.closest('.rb-mark');
    if (mark) { this.#send('seek', Math.max(0, Number(mark.dataset.at) - 5)); return; }
    const b = e.target.closest('[data-rb]');
    if (!b) return;
    const a = b.dataset.rb;
    if (a === 'toggle') this.#send(this.meta.ended ? 'play' : this.meta.paused ? 'play' : 'pause');
    else if (a === 'back') this.#send('jump', -30);
    else if (a === 'fwd') this.#send('jump', 30);
    else if (a === 'speed') this.#send('speed', Number(b.dataset.v));
    else if (a === 'speed-next') this.#send('speed', SPEEDS[(SPEEDS.indexOf(this.meta.speed) + 1) % SPEEDS.length]);
    else if (a === 'list') document.querySelector('[data-open-replays]')?.click();
    else if (a === 'exit') post('/api/mode', { mode: 'live' }).then((r) => r.error ? this.store.toast(r.error) : this.store.toast('Back to live timing', 'ok'));
  }

  /** Where the replay is right now (seconds), moving on between server updates. */
  position() {
    const m = this.meta;
    if (!m) return 0;
    if (m.paused || m.ended) return m.pos;
    const serverNow = Date.now() + this.store.clockOffset;
    return Math.min(m.dur, m.pos + ((serverNow - m.at) / 1000) * m.speed);
  }

  update() {
    const on = this.store.status?.mode === 'replay' && !!this.store.replay;
    document.body.classList.toggle('replaying', on);
    this.el.hidden = !on;
    if (!on) { this.meta = null; this.drawn = ''; return; }
    const m = this.meta = this.store.replay;
    const key = `${m.file}|${m.dur}|${m.speed}|${m.paused}|${m.ended}|${m.marks?.length}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const labels = markLabels(m);
    const pct = (s) => `${((s / (m.dur || 1)) * 100).toFixed(3)}%`;
    this.el.innerHTML = `
      <button class="rb-play" data-rb="toggle" title="${m.ended ? 'Play again' : m.paused ? 'Play' : 'Pause'} (space)" aria-label="${m.ended ? 'Play again' : m.paused ? 'Play' : 'Pause'}">${m.ended ? AGAIN : m.paused ? PLAY : PAUSE}</button>
      <button class="rb-btn rb-skip" data-rb="back" title="Back 30 seconds">−30s</button>
      <button class="rb-btn rb-skip" data-rb="fwd" title="Forward 30 seconds">+30s</button>
      <div class="rb-time" title="Time at the track"><b class="rb-now">--:--</b><span>${m.ended ? 'Finished' : m.paused ? 'Paused' : 'track time'}</span></div>
      <div class="rb-scrub">
        <div class="rb-marks">${labels.map((x) => `<i class="rb-mark m-${x.kind}" style="left:${pct(x.at)}" data-at="${x.at}" data-label="${esc(x.label)}" title="${esc(x.label)} · ${esc(trackTime(m, x.at))}"></i>`).join('')}</div>
        <div class="rb-track"><i class="rb-fill"></i></div>
        <i class="rb-knob"></i>
        <input class="rb-range" type="range" min="0" max="${Math.max(1, m.dur)}" step="1" aria-label="Replay position">
        <div class="rb-hover" hidden></div>
      </div>
      <div class="rb-len"></div>
      <div class="seg rb-speed" title="Playback speed">${SPEEDS.map((v) => `<button data-rb="speed" data-v="${v}" class="${m.speed === v ? 'on' : ''}">${v}×</button>`).join('')}</div>
      <div class="rb-title" title="${esc(m.meeting)} · ${esc(m.session)}"><b>${esc(m.session)}</b> · ${esc(m.meeting)}</div>
      <button class="rb-btn" data-rb="list" title="Pick another session">${LIST}<span>Replays</span></button>
      <button class="rb-btn rb-exit" data-rb="exit" title="Leave the replay and go back to live timing">Live</button>`;
    // On a phone only the current speed shows; tapping it cycles through the speeds.
    if (window.innerWidth <= 900) this.el.querySelector('.rb-speed button.on')?.setAttribute('data-rb', 'speed-next');
    this.lastPaint = null;
  }

  #paint(sec) {
    const m = this.meta;
    const pct = `${((sec / (m.dur || 1)) * 100).toFixed(3)}%`;
    this.el.querySelector('.rb-fill').style.width = pct;
    this.el.querySelector('.rb-knob').style.left = pct;
    const now = trackTime(m, sec) || fmtClock(sec);
    const el = this.el.querySelector('.rb-now');
    if (el.textContent !== now) el.textContent = now;
    const len = `${fmtClock(sec)} / ${fmtClock(m.dur)}`;
    const lenEl = this.el.querySelector('.rb-len');
    if (lenEl.textContent !== len) lenEl.textContent = len;
  }

  #hover(sec, label) {
    const h = this.el.querySelector('.rb-hover');
    if (!h) return;
    if (sec == null) { h.hidden = true; return; }
    h.hidden = false;
    h.style.left = `${((sec / (this.meta.dur || 1)) * 100).toFixed(2)}%`;
    h.textContent = `${label ? `${label} · ` : ''}${trackTime(this.meta, sec) || fmtClock(sec)}`;
  }

  frame() {
    if (!this.meta || this.dragging) return;
    const sec = Math.round(this.position() * 4) / 4;
    if (sec === this.lastPaint) return;
    this.lastPaint = sec;
    this.#paint(sec);
    const r = this.el.querySelector('.rb-range');
    if (r) r.value = String(Math.round(sec));
  }
}
