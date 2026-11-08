// Team radio: list of clips with a single shared audio player.
import { esc, teamColor, sessionLocalTime, sessionKind, sessionStartUtc } from '../format.js';
import { avatar, img, teamLogo } from '../media.js';

const BARS = 7;

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
  // A race is 'Inactive' through the formation lap; it starts at the scheduled time.
  const formationFrom = sessionKind(state) === 'race' ? sessionStartUtc(state?.SessionInfo) : null;
  return (utc) => {
    const t = Date.parse(utc);
    if (!t) return null;
    if (!series.length) return formationFrom && t >= formationFrom && !state?.SessionStatus?.Started && state?.SessionStatus?.Status !== 'Started' ? ['pre', 'Formation lap'] : null;
    let session = null, track = null, everStarted = false;
    for (const s of series) {
      if (s.t > t) break;
      if (s.session) { session = s.session; if (s.session === 'Started') everStarted = true; }
      if (s.track) track = s.track;
    }
    if (session === 'Aborted') return ['red', 'Red flag'];
    if ((session === 'Inactive' || !session) && !everStarted && formationFrom && t >= formationFrom) return ['pre', 'Formation lap'];
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
    this.audio.addEventListener('ended', () => { this.playing = null; this.#mark(); this.#hideCard(); });
    this.audio.addEventListener('error', () => { this.root.querySelector(`.clip[data-path="${CSS.escape(this.playing || '')}"]`)?.classList.add('error'); this.playing = null; this.#mark(); this.#hideCard(); });
    this.audio.addEventListener('playing', () => this.#showCard());
    this.audio.addEventListener('pause', () => this.#hideCard(250)); // short wait: switching clips pauses then plays

    // Who's talking: a card with the driver while a clip plays.
    this.popup = document.getElementById('radio-popup');
    this.popup.checked = localStorage.getItem('radioPopup') !== '0'; // on by default
    this.popup.addEventListener('change', () => {
      localStorage.setItem('radioPopup', this.popup.checked ? '1' : '0');
      if (!this.popup.checked) this.#hideCard();
      else if (this.playing && !this.audio.paused) this.#showCard();
    });
    this.card = document.getElementById('radiocard');
    this.card.addEventListener('click', (e) => {
      if (e.target.closest('[data-rc="stop"]')) { this.audio.pause(); this.playing = null; this.#mark(); return; }
      if (this.card.dataset.num) this.store.select(this.card.dataset.num, { toggle: false });
    });
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
      // Everything passes an analyser on its way out, so the pop-up's bars follow the voice.
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.55;
      // F1's clips are heavily compressed and loud: a high range keeps the bars moving with the words.
      this.analyser.minDecibels = -70;
      this.analyser.maxDecibels = -10;
      this.analyser.connect(this.ctx.destination);
      chain.output.connect(this.analyser);
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
    this.src.connect(this.clean.checked ? this.chainIn : this.analyser);
  }

  /** Show who's talking: photo, name, team, position, voice level, progress. */
  #showCard() {
    clearTimeout(this.hideTimer);
    const cap = this.#captures().find((c) => c.Path === this.playing);
    if (!cap || !this.popup.checked) return;
    const s = this.store.state;
    const num = String(cap.RacingNumber);
    const d = s.DriverList?.[num] || {};
    const line = s.TimingData?.Lines?.[num] || {};
    const tag = contextAt(s)(recordedUtc(cap.Path, s.SessionInfo?.GmtOffset) || cap.Utc);
    const when = cap.Utc ? sessionLocalTime(cap.Utc, s.SessionInfo?.GmtOffset).slice(0, 5) : '';
    this.card.dataset.num = num;
    this.card.style.setProperty('--tc', teamColor(d));
    this.card.innerHTML = `
      <div class="rcard-photo">${avatar(d, 'av')}</div>
      <div class="rcard-main">
        <div class="rcard-k"><span class="rcard-level" aria-hidden="true">${'<i></i>'.repeat(BARS)}</span>Team radio${when ? ` · ${esc(when)}` : ''}${tag ? ` · <em class="clip-tag ${tag[0]}">${esc(tag[1])}</em>` : ''}</div>
        <div class="rcard-name"><b>${esc(d.Tla || num)}</b><span>${esc(d.FullName || d.BroadcastName || '')}</span></div>
        <div class="rcard-team">${img(teamLogo(d), 'rcard-logo')}<span>${esc(d.TeamName || '')}${line.Position ? ` · P${esc(line.Position)}` : ''}</span></div>
        <div class="rcard-bar"><i></i></div>
      </div>
      <button class="rcard-stop" data-rc="stop" title="Stop" aria-label="Stop"><svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/></svg></button>`;
    this.card.hidden = false;
    this.card.classList.remove('out');
    this.card.classList.add('in');
    this.bars = [...this.card.querySelectorAll('.rcard-level i')];
    this.cardBar = this.card.querySelector('.rcard-bar i');
    cancelAnimationFrame(this.levelRaf);
    this.#level();
  }

  #hideCard(wait = 0) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.card.hidden || (!this.audio.paused && this.playing)) return;
      cancelAnimationFrame(this.levelRaf);
      this.card.classList.add('out');
      this.hideTimer = setTimeout(() => { this.card.hidden = true; this.card.classList.remove('in', 'out'); }, 320);
    }, wait);
  }

  /** Voice level bars: speech bands from the analyser (or a gentle idle pulse without Web Audio). */
  #level() {
    const a = this.analyser;
    const data = a ? new Uint8Array(a.frequencyBinCount) : null;
    const hz = a ? this.ctx.sampleRate / a.fftSize : 0;
    const step = () => {
      if (this.card.hidden) return;
      if (a) {
        a.getByteFrequencyData(data);
        // Seven bands between 250 Hz and 3.6 kHz, where a voice on the radio sits.
        for (let i = 0; i < BARS; i++) {
          const lo = Math.floor((250 * 1.49 ** i) / hz), hi = Math.max(lo + 1, Math.floor((250 * 1.49 ** (i + 1)) / hz));
          let sum = 0;
          for (let k = lo; k < hi && k < data.length; k++) sum += data[k];
          const v = Math.min(1, Math.max(0, (sum / (hi - lo) / 255 - 0.1) * 1.7));
          this.bars[i].style.transform = `scaleY(${(0.12 + v * 0.88).toFixed(3)})`;
        }
      } else {
        const t = performance.now() / 180;
        this.bars.forEach((b, i) => { b.style.transform = `scaleY(${(0.35 + 0.3 * Math.abs(Math.sin(t + i * 0.9))).toFixed(3)})`; });
      }
      if (this.audio.duration) this.cardBar.style.width = `${(this.audio.currentTime / this.audio.duration) * 100}%`;
      this.levelRaf = requestAnimationFrame(step);
    };
    step();
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
