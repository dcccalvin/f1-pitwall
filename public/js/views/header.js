// Top bar: event, track status, lap / clock, weather, delay control, connection.
import { esc, trackState, sessionKind, parseClock, fmtClock, driverOrder } from '../format.js';

const $ = (id) => document.getElementById(id);

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
    document.body.dataset.track = ts.key;
    $('track-label').textContent = ts.label;

    const kind = sessionKind(s);
    if (kind === 'race' && s.LapCount) {
      $('lc-label').textContent = 'Lap';
      const html = `${esc(s.LapCount.CurrentLap ?? '–')}<small>/${esc(s.LapCount.TotalLaps ?? '–')}</small>`;
      if ($('lc-value').innerHTML !== html) $('lc-value').innerHTML = html;
      const pct = (Number(s.LapCount.CurrentLap) - 1) / (Number(s.LapCount.TotalLaps) || 1);
      $('lc-bar').style.width = `${Math.max(0, Math.min(1, pct)) * 100}%`;
      this.clockMode = false;
    } else {
      $('lc-label').textContent = kind === 'quali' ? `Q${Number(s.TimingData?.SessionPart) || 1} · left` : 'Time left';
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

  frame(now) {
    if (!this.clockMode) return;
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
