// Team radio: list of clips with a single shared audio player.
import { esc, teamColor, sessionLocalTime } from '../format.js';

const PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';

export class TeamRadio {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('radio-list');
    this.auto = document.getElementById('radio-auto');
    this.auto.checked = localStorage.getItem('radioAuto') === '1';
    this.auto.addEventListener('change', () => localStorage.setItem('radioAuto', this.auto.checked ? '1' : '0'));
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.playing = null;
    this.count = -1;
    this.audio.addEventListener('timeupdate', () => this.#progress());
    this.audio.addEventListener('ended', () => { this.playing = null; this.#mark(); });
    this.audio.addEventListener('error', () => { this.root.querySelector(`.clip[data-path="${CSS.escape(this.playing || '')}"]`)?.classList.add('error'); this.playing = null; this.#mark(); });
    this.root.addEventListener('click', (e) => {
      const c = e.target.closest('.clip');
      if (c) this.toggle(c.dataset.path);
    });
  }

  #url(path) {
    const base = this.store.state.SessionInfo?.Path || '';
    return `/api/radio?path=${encodeURIComponent(base + path)}`;
  }

  toggle(path) {
    if (this.playing === path && !this.audio.paused) { this.audio.pause(); this.playing = null; this.#mark(); return; }
    this.playing = path;
    this.audio.src = this.#url(path);
    this.audio.play().catch(() => { this.playing = null; this.#mark(); });
    this.#mark();
  }

  #mark() {
    for (const c of this.root.querySelectorAll('.clip')) {
      const on = c.dataset.path === this.playing;
      c.classList.toggle('playing', on);
      c.querySelector('.play').innerHTML = on ? PAUSE : PLAY;
      if (!on) c.querySelector('.clip-bar i').style.width = '0';
    }
  }

  #progress() {
    if (!this.playing || !this.audio.duration) return;
    const c = this.root.querySelector(`.clip[data-path="${CSS.escape(this.playing)}"]`);
    if (c) c.querySelector('.clip-bar i').style.width = `${(this.audio.currentTime / this.audio.duration) * 100}%`;
  }

  #captures() {
    const raw = this.store.state.TeamRadio?.Captures;
    return (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean);
  }

  update() {
    const caps = this.#captures();
    if (caps.length === this.count) return;
    const fresh = this.count >= 0 ? caps.length - this.count : 0;
    this.count = caps.length;
    const dl = this.store.state.DriverList || {};
    const off = this.store.state.SessionInfo?.GmtOffset;
    if (!caps.length) { this.root.innerHTML = '<div class="feed-empty">No team radio yet this session.</div>'; return; }
    this.root.innerHTML = caps.slice().reverse().map((c, i) => {
      const d = dl[c.RacingNumber] || {};
      return `<div class="clip${i < fresh ? ' fresh' : ''}" data-path="${esc(c.Path)}" style="--tc:${teamColor(d)}">
        <button class="play" aria-label="Play">${PLAY}</button>
        <div><div class="clip-who"><b>${esc(d.Tla || c.RacingNumber)}</b><span>${esc(d.FullName || d.BroadcastName || '')} · ${esc(d.TeamName || '')}</span></div><div class="clip-bar"><i></i></div></div>
        <div class="clip-time">${esc(c.Utc ? sessionLocalTime(c.Utc, off) : '')}</div>
      </div>`;
    }).join('');
    this.#mark();
    if (fresh > 0) this.store.notify('radio');
  }

  onMessage(t, topic, data) {
    if (topic !== 'TeamRadio' || !this.auto.checked) return;
    const caps = Array.isArray(data?.Captures) ? data.Captures : Object.values(data?.Captures || {});
    const last = caps.filter(Boolean).at(-1);
    if (last && (this.audio.paused || !this.playing)) setTimeout(() => this.toggle(last.Path), 300);
  }
}
