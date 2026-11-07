// Top bar: event, track status, lap / clock, weather, delay control, connection.
import { esc, trackState, sessionKind, sessionPhase, restartInfo, parseClock, fmtClock, driverOrder } from '../format.js';

const $ = (id) => document.getElementById(id);

/** SessionInfo.StartDate is local track time; GmtOffset turns it into UTC ms. */
function sessionStartUtc(info) {
  if (!info?.StartDate) return null;
  const local = Date.parse(`${info.StartDate.slice(0, 19)}Z`);
  const m = /^(-)?(\d+):(\d+)/.exec(info.GmtOffset || '');
  if (isNaN(local)) return null;
  const off = m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return local - off * 60000;
}

/** Restart a CSS animation class on an element. */
function retrigger(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export class Header {
  constructor(store) {
    this.store = store;
    this.pop = $('delay-pop');
    this.range = $('delay-range');
    $('delay-btn').addEventListener('click', (e) => { e.stopPropagation(); this.#toggle(); });
    document.addEventListener('click', (e) => { if (!this.pop.hidden && !this.pop.contains(e.target)) this.pop.hidden = true; });
    this.pop.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => store.setDelay(store.delay + Number(b.dataset.d))));
    this.pop.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => store.setDelay(Number(b.dataset.p))));
    this.range.addEventListener('input', () => { $('delay-big').textContent = `${this.range.value}s`; });
    this.range.addEventListener('change', () => store.setDelay(Number(this.range.value)));
    $('sync-btn').addEventListener('click', () => { const n = $('sync-driver').value; if (n) store.sync(n); });
  }

  #toggle() {
    this.pop.hidden = !this.pop.hidden;
    if (this.pop.hidden) return;
    const r = $('delay-btn').getBoundingClientRect();
    this.pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 368, r.right - 360))}px`;
    this.#syncOptions();
  }

  #syncOptions() {
    const s = this.store.state;
    const dl = s.DriverList || {};
    const order = driverOrder(s);
    const sel = $('sync-driver');
    const keep = sel.value;
    sel.innerHTML = order.map((n, i) => `<option value="${esc(n)}">${i === 0 ? 'Leader · ' : ''}${esc(dl[n]?.Tla || n)} (P${esc(s.TimingData?.Lines?.[n]?.Position || i + 1)})</option>`).join('');
    if (keep && order.includes(keep)) sel.value = keep;
  }

  update() {
    const s = this.store.state;
    const info = s.SessionInfo || {};
    $('event-name').textContent = info.Meeting?.Name ? `${info.Meeting.Name} · ${info.Meeting.Circuit?.ShortName || ''}` : '—';
    $('event-cc').textContent = info.Meeting?.Country?.Code || '—';
    $('session-name').textContent = info.Name || (this.store.connected ? 'No session' : 'Connecting…');
    const badge = $('mode-badge');
    const mode = this.store.status?.mode;
    badge.hidden = !(mode === 'demo' || mode === 'replay');
    badge.textContent = mode === 'demo' ? 'Demo' : 'Replay';

    const ts = trackState(s);
    if (document.body.dataset.track !== ts.key) {
      const first = !this.seenTrack;
      document.body.dataset.track = ts.key;
      if (!first) retrigger($('track-pill'), 'enter');
      this.seenTrack = true;
    }
    if ($('track-label').textContent !== ts.label) $('track-label').textContent = ts.label;

    const kind = sessionKind(s);
    const phase = sessionPhase(s);
    const restart = restartInfo(s);
    // Before the start (or while waiting to restart after a red flag) F1 sends
    // a frozen clock. Count down to the announced (re)start time instead.
    this.countTo = null;
    if (phase === 'pre') {
      this.countTo = restart?.kind === 'start' ? restart.utc : sessionStartUtc(s.SessionInfo);
      this.countLabel = ['Starts in', 'Starting'];
    } else if ((phase === 'paused' || phase === 'suspended') && restart?.kind === 'resume') {
      this.countTo = restart.utc;
      this.countLabel = ['Resumes in', 'Resuming'];
    }
    this.frozen = phase === 'suspended' || phase === 'paused';
    if (this.countTo) {
      $('lc-label').textContent = this.countLabel[0];
      this.clockMode = true;
      $('lc-bar').style.width = '0%';
    } else if (kind === 'race' && s.LapCount) {
      $('lc-label').textContent = 'Lap';
      const html = `${esc(s.LapCount.CurrentLap ?? '–')}<small>/${esc(s.LapCount.TotalLaps ?? '–')}</small>`;
      if ($('lc-value').innerHTML !== html) {
        const had = $('lc-value').innerHTML.includes('<small>');
        $('lc-value').innerHTML = html;
        if (had) retrigger($('lc-value'), 'tick'); // the lap counter ticks over
      }
      const pct = (Number(s.LapCount.CurrentLap) - 1) / (Number(s.LapCount.TotalLaps) || 1);
      $('lc-bar').style.width = `${Math.max(0, Math.min(1, pct)) * 100}%`;
      this.clockMode = false;
    } else {
      const part = kind === 'quali' ? `Q${Number(s.TimingData?.SessionPart) || 1} · ` : '';
      $('lc-label').textContent = this.frozen ? `${part}stopped` : kind === 'quali' ? `${part}left` : 'Time left';
      this.clockMode = true;
      this.sessionLen = { practice: 3600, quali: [1080, 900, 720][(Number(s.TimingData?.SessionPart) || 1) - 1] }[kind] || 3600;
    }

    const w = s.WeatherData;
    if (w) {
      // F1 occasionally sends a bogus 0.0 reading; keep the last good one.
      if (Number(w.AirTemp) > 0) $('wx-air').textContent = `${Number(w.AirTemp).toFixed(1)}°`;
      if (Number(w.TrackTemp) > 0) $('wx-track').textContent = `${Number(w.TrackTemp).toFixed(1)}°`;
      $('wx-hum').textContent = `${Math.round(Number(w.Humidity))}%`;
      $('wx-wind').textContent = `${Number(w.WindSpeed).toFixed(1)}`;
      // Wind direction is where it blows FROM; arrow points where it goes.
      $('wx-arrow').style.transform = `rotate(${(Number(w.WindDirection) + 180) % 360}deg)`;
      $('wx-rain').hidden = !(Number(w.Rainfall) > 0);
    }
    this.#wet(s);

    const st = this.store.status || {};
    const state = !this.store.connected ? 'reconnecting' : st.state || 'connecting';
    $('conn').dataset.state = state;
    $('conn-label').textContent = { live: 'Live', demo: 'Demo', replay: 'Replay', connecting: 'Connecting', reconnecting: 'Reconnecting', error: 'Feed error', disconnected: 'Offline', starting: 'Starting' }[state] || state;
    const f1tv = !!st.f1tv;
    $('data-badge').textContent = f1tv ? 'F1 TV data' : 'Free data';
    $('data-badge').classList.toggle('f1tv', f1tv);

    $('delay-v').textContent = `${this.store.delay}s`;
    $('delay-big').textContent = `${this.store.delay}s`;
    if (document.activeElement !== this.range) this.range.value = this.store.delay;
    this.range.max = this.store.maxDelay || 300;
  }

  /** Rain / wet-session chip: live rainfall, race control wet declarations, rain risk, wet tyres. */
  #wet(s) {
    const raining = Number(s.WeatherData?.Rainfall) > 0;
    const raw = s.RaceControlMessages?.Messages;
    const msgs = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean).map((m) => String(m.Message || ''));
    // Walk race control in order so later messages override earlier ones.
    let declared = false, lowGrip = false, overtakeOff = false, risk = null;
    for (const m of msgs) {
      if (/DECLARED WET|WET RACE|WET SESSION|TRACK IS WET|WET TRACK/i.test(m)) declared = true;
      if (/DRY TRACK|TRACK (IS )?DRY|DECLARED DRY/i.test(m)) declared = false;
      if (/LOW GRIP CONDITIONS|LOW GRIP DELTA ACTIVE/i.test(m)) lowGrip = true;
      if (/NORMAL GRIP|LOW GRIP (CONDITIONS )?(ENDED|NO LONGER)/i.test(m)) lowGrip = false;
      if (/OVERTAKE (MODE )?DISABLED/i.test(m)) overtakeOff = true;
      if (/OVERTAKE (MODE )?ENABLED/i.test(m)) overtakeOff = false;
      const r = /RISK OF RAIN[^0-9]*(\d+)\s*%/i.exec(m);
      if (r) risk = Number(r[1]);
    }
    const lines = s.TimingData?.Lines || {};
    const wetTyres = Object.keys(lines).filter((n) => {
      const st = s.TimingAppData?.Lines?.[n]?.Stints;
      const last = st ? (Array.isArray(st) ? st.at(-1) : st[Math.max(...Object.keys(st).map(Number))]) : null;
      return last && /INTERMEDIATE|WET/.test(last.Compound || '') && !lines[n]?.InPit && !lines[n]?.Retired;
    }).length;

    const parts = [];
    if (raining) parts.push('Raining');
    if (declared) parts.push('Wet track');
    if (lowGrip && !declared) parts.push('Low grip');
    if (wetTyres) parts.push(`${wetTyres} on wets`);
    if (!parts.length && risk) parts.push(`Rain risk ${risk}%`);
    const label = parts.join(' · ');
    const cls = raining || declared || lowGrip || wetTyres ? 'rain' : 'risk';
    const chip = $('wet-chip');
    chip.hidden = !label;
    chip.className = `wet-chip ${cls}`;
    chip.title = [
      raining && 'Rain is falling at the track (weather station)',
      declared && 'Race control: WET TRACK',
      lowGrip && 'Race control: low grip conditions',
      overtakeOff && 'Race control: overtake mode disabled',
      wetTyres && `${wetTyres} cars on intermediate or wet tyres`,
      risk && `Race control: ${risk}% risk of rain`,
    ].filter(Boolean).join('\n');
    if ($('wet-label').textContent !== label) $('wet-label').textContent = label;

    // Tell the user once when rain starts (not on first load).
    if (this.wasRaining === false && raining) this.store.toast('Rain is falling at the track', 'rain');
    this.wasRaining = raining;
  }

  frame(now) {
    if (!this.clockMode) return;
    if (this.countTo) {
      const left = (this.countTo - now) / 1000;
      const txt = left > 0 ? fmtClock(left) : 'Soon';
      const el = $('lc-value');
      if (el.textContent !== txt) el.textContent = txt;
      const label = this.countLabel[left > 0 ? 0 : 1];
      if ($('lc-label').textContent !== label) $('lc-label').textContent = label;
      return;
    }
    const c = this.store.state.ExtrapolatedClock;
    let txt = '—', rem = null;
    if (c?.Remaining) {
      rem = parseClock(c.Remaining);
      // Live: count down from the feed's own timestamp. Replays: from when the
      // clock message was played back (its original timestamp is in the past).
      const seen = this.store.clockSeen;
      const from = this.store.status?.mode === 'replay' && seen?.utc === c.Utc ? seen.t : Date.parse(c.Utc);
      if (c.Extrapolating && from) rem -= (now - from) / 1000;
      rem = Math.max(0, rem);
      txt = fmtClock(rem);
    }
    const el = $('lc-value');
    if (el.textContent !== txt) el.textContent = txt;
    if (rem != null) $('lc-bar').style.width = `${Math.max(0, Math.min(1, 1 - rem / (this.sessionLen || 3600))) * 100}%`;
  }
}
