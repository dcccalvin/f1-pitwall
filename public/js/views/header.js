// Top bar: event, track status, lap / clock, weather, delay control, connection.
import { esc, trackState, sessionKind, sessionPhase, restartInfo, parseClock, fmtClock, driverOrder, sessionStartUtc, startProcedure, sessionOver } from '../format.js';
import { crossover, paceShift } from '../crossover.js';

const $ = (id) => document.getElementById(id);

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
    const dnow = this.store.dataNow();
    const mode = this.store.status?.mode;
    // Between sessions (an old session, or none): name the next event, not the last one.
    const idle = mode === 'live' && (sessionOver(s, dnow) || !Object.keys(s.TimingData?.Lines || {}).length);
    const nm = idle ? this.store.nextup?.meeting : null;
    const upNext = idle ? this.store.nextup?.next : null;
    const eventName = nm?.name ? `${nm.name}${nm.circuit ? ` · ${nm.circuit}` : ''}` : info.Meeting?.Name ? `${info.Meeting.Name} · ${info.Meeting.Circuit?.ShortName || ''}` : '—';
    $('event-name').textContent = eventName;
    $('event-cc').textContent = (nm ? nm.countryCode : info.Meeting?.Country?.Code) || '—';
    $('session-name').textContent = upNext?.name || info.Name || (this.store.connected ? 'No session' : 'Connecting…');
    const badge = $('mode-badge');
    badge.hidden = !(mode === 'demo' || mode === 'replay' || upNext);
    badge.textContent = mode === 'demo' ? 'Demo' : mode === 'replay' ? 'Replay' : 'Up next';

    const ts = trackState(s, dnow);
    const kind = sessionKind(s);
    const phase = sessionPhase(s);
    // A full state (connecting, changing delay, jumping in a replay) is not a change
    // that happened on track: no flag or lights-out animation for it.
    const fresh = this.gen !== this.store.stateGen;
    this.gen = this.store.stateGen;
    if (document.body.dataset.track !== ts.key) {
      const first = !this.seenTrack || fresh;
      document.body.dataset.track = ts.key;
      if (!first) { retrigger($('track-pill'), 'enter'); this.store.flagShow?.(ts.key, ts.label); }
      this.seenTrack = true;
    }
    // Lights out: a race goes from not running to running (start, or a standing
    // restart after a red flag; not when the safety car leads them away).
    if (!fresh && kind === 'race' && phase === 'running' && ['pre', 'paused', 'suspended'].includes(this.phase) && ts.key !== 'sc') this.store.lightsOut?.();
    this.phase = phase;
    // An old session the feed keeps re-sending: say it's over, count down to what's next.
    const over = this.store.status?.mode === 'live' && sessionOver(s, dnow);
    const label = over ? `${info.Name || 'Session'} finished` : ts.label;
    if ($('track-label').textContent !== label) $('track-label').textContent = label;
    // Nothing on track: the countdown to the next session says it all.
    $('track-pill').hidden = over;

    const restart = restartInfo(s);
    const proc = startProcedure(s, dnow);
    // Before the start (or while waiting to restart after a red flag) F1 sends
    // a frozen clock. Count down to the announced (re)start time instead.
    this.countTo = null;
    this.formation = null;
    const nx = this.store.nextup?.next;
    if (over) {
      if (nx?.start) { this.countTo = Date.parse(nx.start); this.countLabel = [`${nx.name} in`, `${nx.name} starting`]; }
    } else if (proc?.stage === 'countdown') {
      this.countTo = proc.to;
      this.countLabel = ['Starts in', 'Starting'];
    } else if (proc) {
      this.formation = proc; // formation lap: lights out comes next
    } else if (phase === 'pre') {
      this.countTo = restart?.kind === 'start' ? restart.utc : sessionStartUtc(s.SessionInfo);
      this.countLabel = ['Starts in', 'Starting'];
    } else if ((phase === 'paused' || phase === 'suspended') && restart?.kind === 'resume') {
      this.countTo = restart.utc;
      this.countLabel = ['Resumes in', 'Resuming'];
    }
    this.frozen = phase === 'suspended' || phase === 'paused';
    if (this.formation) {
      $('lc-label').textContent = this.formation.label;
      const total = s.LapCount?.TotalLaps;
      const html = total ? `${esc(total)}<small> laps</small>` : '—';
      if ($('lc-value').innerHTML !== html) $('lc-value').innerHTML = html;
      $('lc-bar').style.width = '0%';
      this.clockMode = false;
    } else if (this.countTo) {
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
      const sprint = /sprint/i.test(s.SessionInfo?.Name || '');
      const part = kind === 'quali' ? `${sprint ? 'SQ' : 'Q'}${Number(s.TimingData?.SessionPart) || 1} · ` : '';
      $('lc-label').textContent = this.frozen ? `${part}stopped` : kind === 'quali' ? `${part}left` : 'Time left';
      this.clockMode = true;
      // Qualifying parts: 18/15/12 min; sprint qualifying: 12/10/8 min.
      this.sessionLen = { practice: 3600, quali: (sprint ? [720, 600, 480] : [1080, 900, 720])[(Number(s.TimingData?.SessionPart) || 1) - 1] }[kind] || 3600;
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
    // The rain chip is about the session on track; an old session's "low grip" is no news.
    if (over) $('wet-chip').hidden = true;
    else this.#wet(s, fresh);

    const st = this.store.status || {};
    const state = !this.store.connected ? 'reconnecting' : st.state || 'connecting';
    $('conn').dataset.state = state;
    $('conn-label').textContent = { live: 'Live', demo: 'Demo', replay: 'Replay', connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'No internet', error: 'Feed error', disconnected: 'Offline', starting: 'Starting' }[state] || state;
    const f1tv = !!st.f1tv;
    $('data-badge').textContent = f1tv ? 'F1 TV data' : 'Free data';
    $('data-badge').classList.toggle('f1tv', f1tv);

    $('delay-v').textContent = `${this.store.delay}s`;
    $('delay-big').textContent = `${this.store.delay}s`;
    if (document.activeElement !== this.range) this.range.value = this.store.delay;
    this.range.max = this.store.maxDelay || 300;
  }

  /** Rain / wet-session chip: live rainfall, race control wet declarations, rain risk, wet tyres. */
  #wet(s, fresh) {
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
    const cond = this.#conditions(s, fresh);
    if (cond.chip) parts.push(cond.chip);
    const label = parts.join(' · ');
    const cls = raining || declared || lowGrip || wetTyres || cond.chip ? 'rain' : 'risk';
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
      cond.detail,
    ].filter(Boolean).join('\n');
    if ($('wet-label').textContent !== label) $('wet-label').textContent = label;

    // Tell the user once when rain starts (not on first load).
    if (!fresh && this.wasRaining === false && raining) this.store.toast('Rain is falling at the track', 'rain');
    this.wasRaining = raining;
  }

  /**
   * Lap times as a weather signal (races): slicks suddenly slower = rain or lost grip,
   * inters suddenly quicker = drying track, and which tyre is faster once cars run both.
   * Checked every 10 s; each kind of alert at most once every 5 minutes.
   * (In the 2026 São Paulo GP, slicks were 1.3–1.8 s a lap slower 2–4 minutes before
   * the field pitted for inters.)
   */
  #conditions(s, fresh) {
    if (sessionKind(s) !== 'race' || sessionPhase(s) !== 'running' || !this.store.history) return {};
    if (this.cond && Date.now() - (this.condAt || 0) < 10000) return this.cond;
    this.condAt = Date.now();
    const until = this.store.playNow();
    const green = String(s.TrackStatus?.Status ?? '1') === '1';
    const shift = green ? paceShift(this.store.history, until) : {};
    const cross = crossover(this.store.history, until);
    let chip = '', alert = null;
    const detail = [];
    if (cross) {
      chip = `${cross.faster === 'slicks' ? 'Slicks' : 'Inters'} faster ${cross.by.toFixed(1)}s`;
      detail.push(`Last clean laps: slicks ${cross.dry.time.toFixed(1)} s (${cross.dry.cars} cars), inters ${cross.wet.time.toFixed(1)} s (${cross.wet.cars} cars)`);
      if (this.crossFaster && this.crossFaster !== cross.faster) alert = { key: 'cross', text: `Crossover: ${cross.faster} are now ${cross.by.toFixed(1)} s a lap faster` };
      this.crossFaster = cross.faster;
    }
    if (shift.dry?.change >= 1.25 && shift.dry.cars >= 6) {
      chip ||= `Slicks +${shift.dry.change.toFixed(1)}s`;
      detail.push(`Slicks are ${shift.dry.change.toFixed(1)} s slower than a lap earlier (${shift.dry.cars} cars): rain or less grip`);
      alert ||= { key: 'slicks', text: `Slicks losing ${shift.dry.change.toFixed(1)} s a lap (${shift.dry.cars} cars): rain or less grip, watch for stops for inters` };
    }
    if (shift.wet?.change <= -1.5 && shift.wet.cars >= 6) {
      chip ||= `Inters ${shift.wet.change.toFixed(1)}s`;
      detail.push(`Inters are ${Math.abs(shift.wet.change).toFixed(1)} s quicker than a lap earlier (${shift.wet.cars} cars): the track is drying`);
      alert ||= { key: 'drying', text: `Track drying: inters ${Math.abs(shift.wet.change).toFixed(1)} s a lap quicker (${shift.wet.cars} cars), watch for the switch to slicks` };
    }
    this.alerted ||= {};
    if (alert && !fresh && Date.now() - (this.alerted[alert.key] || 0) > 5 * 60000) {
      this.alerted[alert.key] = Date.now();
      this.store.toast(alert.text, 'rain');
      this.store.moment?.(alert.text, 'rain');
    }
    this.cond = { chip, detail: detail.join('\n') };
    return this.cond;
  }

  frame() {
    if (!this.clockMode) return;
    const now = this.store.dataNow(); // in a replay: the time in the recording
    if (this.countTo) {
      const left = (this.countTo - now) / 1000;
      // Reaching the scheduled start of a race means the formation lap: redraw.
      if (left <= 0 && this.countedTo !== this.countTo) { this.countedTo = this.countTo; this.store.dirty(); }
      const txt = left > 0 ? (left >= 86400 ? `${Math.floor(left / 86400)}d ${fmtClock(left % 86400)}` : fmtClock(left)) : 'Soon';
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
      // Count down from the feed's own timestamp (in a replay, `now` is recording time).
      const from = Date.parse(String(c.Utc).endsWith('Z') ? c.Utc : `${c.Utc}Z`);
      if (c.Extrapolating && from) rem -= (now - from) / 1000;
      rem = Math.max(0, rem);
      txt = fmtClock(rem);
    }
    const el = $('lc-value');
    if (el.textContent !== txt) el.textContent = txt;
    if (rem != null) $('lc-bar').style.width = `${Math.max(0, Math.min(1, 1 - rem / (this.sessionLen || 3600))) * 100}%`;
  }
}
