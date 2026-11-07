// Team radio: list of clips with a single shared audio player.
import { esc, teamColor, sessionLocalTime } from '../format.js';
import { avatar } from '../media.js';

const PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';

/**
 * Voice-clarity chain for F1's raw in-car radio. The clips carry a lot of engine
 * noise; this can't remove it (engine and voice overlap in pitch) but it cuts the
 * rumble below speech and the whine above it, lifts the speech presence band and
 * evens out the level. Returns { input, output } nodes.
 */
export function buildVoiceChain(ctx) {
  const biquad = (type, frequency, Q, gain = 0) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = frequency; f.Q.value = Q; f.gain.value = gain;
    return f;
  };
  const hp1 = biquad('highpass', 240, 0.71);      // two stages = steep cut of engine rumble
  const hp2 = biquad('highpass', 240, 0.71);
  const mud = biquad('peaking', 600, 1.2, -3);    // engine firing band, gently pulled down
  const presence = biquad('peaking', 2600, 0.9, 5); // where consonants (intelligibility) live
  const lp1 = biquad('lowpass', 3900, 0.71);      // two stages = steep cut of high-rev whine and hiss
  const lp2 = biquad('lowpass', 3900, 0.71);
  const comp = ctx.createDynamicsCompressor();     // quiet words up, shouts down
  comp.threshold.value = -32; comp.knee.value = 12; comp.ratio.value = 4;
  comp.attack.value = 0.004; comp.release.value = 0.25;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.15;
  hp1.connect(hp2).connect(mud).connect(presence).connect(lp1).connect(lp2).connect(comp).connect(makeup);
  return { input: hp1, output: makeup };
}

/** F1 names clips like LEC_16_20261107_113741.mp3 (local track time it was recorded). */
function recordedUtc(path, gmtOffset) {
  const r = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp3$/.exec(path || '');
  if (!r) return null;
  const m = /^(-)?(\d+):(\d+)/.exec(gmtOffset || '');
  const off = m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = Date.parse(`${r[1]}-${r[2]}-${r[3]}T${r[4]}:${r[5]}:${r[6]}Z`);
  return isNaN(local) ? null : new Date(local - off * 60000).toISOString();
}

/**
 * What was going on when a clip was recorded, from F1's own status timeline
 * (SessionData.StatusSeries). Clips stay in the list, so one played during a
 * red flag may have been recorded earlier while the cars were still driving.
 */
function contextAt(state) {
  const raw = state?.SessionData?.StatusSeries;
  const series = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter((x) => x?.Utc)
    .map((x) => ({ t: Date.parse(x.Utc), session: x.SessionStatus, track: x.TrackStatus }))
    .sort((a, b) => a.t - b.t);
  return (utc) => {
    const t = Date.parse(utc);
    if (!t || !series.length) return null;
    let session = null, track = null, everStarted = false;
    for (const s of series) {
      if (s.t > t) break;
      if (s.session) { session = s.session; if (s.session === 'Started') everStarted = true; }
      if (s.track) track = s.track;
    }
    if (session === 'Aborted') return ['red', 'Red flag'];
    if (session === 'Inactive') return everStarted ? ['paused', 'Before restart'] : ['pre', 'Before start'];
    if (session === 'Finished' || session === 'Finalised' || session === 'Ends') return ['pre', 'After the chequered flag'];
    if (/SCDeployed/i.test(track || '')) return ['sc', 'Safety car'];
    if (/VSC/i.test(track || '')) return ['sc', 'VSC'];
    if (/Red/i.test(track || '')) return ['red', 'Red flag'];
    return null;
  };
}

export class TeamRadio {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('radio-list');
    this.auto = document.getElementById('radio-auto');
    this.auto.checked = localStorage.getItem('radioAuto') === '1';
    this.auto.addEventListener('change', () => localStorage.setItem('radioAuto', this.auto.checked ? '1' : '0'));
    this.clean = document.getElementById('radio-clean');
    this.clean.checked = localStorage.getItem('radioClean') !== '0'; // on by default
    this.clean.addEventListener('change', () => {
      localStorage.setItem('radioClean', this.clean.checked ? '1' : '0');
      this.#route();
    });
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

  /** Web Audio graph, created on the first play (browsers need a click first). */
  #ensureGraph() {
    if (this.ctx || this.graphFailed) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.src = this.ctx.createMediaElementSource(this.audio);
      const chain = buildVoiceChain(this.ctx);
      chain.output.connect(this.ctx.destination);
      this.chainIn = chain.input;
      this.#route();
    } catch (e) {
      // Fall back to plain playback if the browser can't do it.
      console.warn('voice filter unavailable', e);
      this.graphFailed = true;
      this.ctx = null;
    }
  }

  #route() {
    if (!this.ctx) return;
    this.src.disconnect();
    this.src.connect(this.clean.checked ? this.chainIn : this.ctx.destination);
  }

  toggle(path) {
    if (this.playing === path && !this.audio.paused) { this.audio.pause(); this.playing = null; this.#mark(); return; }
    this.#ensureGraph();
    this.ctx?.resume?.();
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
    if (caps.length === this.count && this.drawnSel === this.store.selected) return;
    this.drawnSel = this.store.selected;
    const fresh = this.count >= 0 ? caps.length - this.count : 0;
    this.count = caps.length;
    const dl = this.store.state.DriverList || {};
    const off = this.store.state.SessionInfo?.GmtOffset;
    if (!caps.length) { this.root.innerHTML = '<div class="feed-empty">No team radio yet this session.</div>'; return; }
    const ctx = contextAt(this.store.state);
    this.root.innerHTML = caps.slice().reverse().map((c, i) => {
      const d = dl[c.RacingNumber] || {};
      const tag = ctx(recordedUtc(c.Path, off) || c.Utc);
      const mine = String(c.RacingNumber) === String(this.store.selected);
      return `<div class="clip${i < fresh ? ' fresh' : ''}${mine ? ' mine' : ''}" data-path="${esc(c.Path)}" style="--tc:${teamColor(d)}">
        <button class="play" aria-label="Play">${PLAY}</button>
        <div><div class="clip-who">${avatar(d, "av av-sm")}<b data-select="${esc(c.RacingNumber)}" title="Follow ${esc(d.Tla || c.RacingNumber)}">${esc(d.Tla || c.RacingNumber)}</b>${tag ? `<em class="clip-tag ${tag[0]}" title="What was happening when this clip was recorded">${tag[1]}</em>` : ''}<span>${esc(d.FullName || d.BroadcastName || '')} · ${esc(d.TeamName || '')}</span></div><div class="clip-bar"><i></i></div></div>
        <div class="clip-time" title="Recorded at (track time)">${esc(c.Utc ? sessionLocalTime(c.Utc, off) : '')}</div>
      </div>`;
    }).join('');
    this.#mark();
    if (fresh > 0) this.store.notify('radio');
  }

  onMessage(t, topic, data) {
    if (topic !== 'TeamRadio') return;
    const caps = Array.isArray(data?.Captures) ? data.Captures : Object.values(data?.Captures || {});
    const last = caps.filter(Boolean).at(-1);
    const sel = this.store.selected;
    if (last && sel && this.store.alerts && String(last.RacingNumber) === String(sel)) {
      const tla = this.store.state.DriverList?.[sel]?.Tla || sel;
      this.store.toast(`New team radio from ${tla} · click to play`, 'driver', () => this.toggle(last.Path));
    }
    if (!this.auto.checked) return;
    if (last && (this.audio.paused || !this.playing)) setTimeout(() => this.toggle(last.Path), 300);
  }
}
