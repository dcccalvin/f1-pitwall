// "Up next": what the timing panel shows when nothing is running. Instead of the
// last session's stale timing (F1's feed keeps re-sending it between sessions):
// a countdown to the next session, the weather forecast for its start and, before
// a race or sprint, the starting grid after penalties and why it differs from
// qualifying.
import { esc, fmtClock, sessionOver, startProcedure, sessionKind, sessionLocalTime, currentStint, compoundLetter } from '../format.js';
import { avatar } from '../media.js';

const DROP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5C6 4.6 3.8 7 3.8 9.6a4.2 4.2 0 0 0 8.4 0C12.2 7 10 4.6 8 1.5Z" fill="currentColor"/></svg>';

const countdown = (ms) => {
  if (ms <= 0) return 'Starting';
  const days = Math.floor(ms / 86400e3);
  return days >= 1 ? `${days}d ${fmtClock((ms / 1000) % 86400)}` : fmtClock(ms / 1000);
};

function verdict(w) {
  if (!w) return null;
  const later = Math.max(...(w.later || []).map((x) => x.rainChance ?? 0), 0);
  if ((w.rainChance ?? 0) >= 60 && (w.rain ?? 0) >= 0.2) return { cls: 'wet', text: 'Wet start likely' };
  if ((w.rainChance ?? 0) >= 35) return { cls: 'risk', text: 'Rain possible at the start' };
  if (later >= 50) return { cls: 'risk', text: 'Dry start, rain possible later' };
  return { cls: 'dry', text: 'Dry start expected' };
}

export class NextUp {
  constructor(store) {
    this.store = store;
    this.data = null;
    this.fetchedAt = 0;
    this.drawn = '';
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hub]');
      if (!b) return;
      if (b.dataset.hub === 'show') this.store.showTiming = this.store.state.SessionInfo?.Key ?? 'none';
      if (b.dataset.hub === 'back') this.store.showTiming = null;
      if (b.dataset.hub === 'demo') document.getElementById('settings-btn').click();
      this.store.dirty();
    });
  }

  /** Is there nothing current to time? (no session, an old finished one, or a race still to start) */
  idle() {
    const s = this.store.state;
    const mode = this.store.status?.mode;
    if (!Object.keys(s.TimingData?.Lines || {}).length) return true;
    if (mode !== 'live') return false;
    const now = this.store.dataNow();
    return sessionOver(s, now) || startProcedure(s, now)?.stage === 'countdown';
  }

  /** Show it in place of the timing tower? (the user can switch to the timing and back) */
  wanted() {
    if (!this.idle()) return false;
    const key = this.store.state.SessionInfo?.Key ?? 'none';
    return !(this.store.showTiming != null && this.store.showTiming === key && Object.keys(this.store.state.TimingData?.Lines || {}).length);
  }

  async load(force = false) {
    if (this.loading || (!force && Date.now() - this.fetchedAt < 4 * 60000)) return;
    this.loading = true;
    try {
      const r = await fetch(`/api/nextup${force ? '?fresh' : ''}`);
      if (r.ok) { this.data = await r.json(); this.store.nextup = this.data; this.fetchedAt = Date.now(); this.store.dirty(); }
    } catch { /* keep the last one */ }
    this.loading = false;
  }

  /** The panel content (redrawn only when the data changes; the countdown ticks in frame()). */
  render(el) {
    this.el = el;
    this.load();
    const d = this.data;
    const s = this.store.state;
    const over = sessionOver(s, this.store.dataNow());
    const lastName = Object.keys(s.TimingData?.Lines || {}).length ? s.SessionInfo?.Name : null;
    const key = `${d?.generated}|${this.store.connected}|${this.store.selected}|${lastName}|${over}|${document.body.dataset.theme}|${s.SessionInfo?.Key}`;
    if (key === this.drawn) return;
    this.drawn = key;
    el.classList.add('hub');

    if (!this.store.connected) { el.innerHTML = '<div class="nu"><h3>Connecting to Pit Wall…</h3><p class="muted">Make sure Pit Wall is running on your laptop.</p></div>'; return; }
    const next = d?.next;
    const start = next ? Date.parse(next.start) : null;
    const off = d?.meeting?.gmtOffset;
    const yours = start ? new Date(start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const track = start && off ? sessionLocalTime(new Date(start).toISOString(), off).slice(0, 5) : '';
    const w = d?.weather;
    const v = verdict(w);

    const top = next ? `<div class="nu-top">
        <div class="nu-when">
          <div class="nu-k">Up next</div>
          <div class="nu-title">${esc(d.meeting?.name || next.race || '')}${d.meeting?.name || next.race ? ' · ' : ''}<b>${esc(next.name)}</b></div>
          <div class="nu-cd" data-to="${start}">${countdown(start - Date.now())}</div>
          <div class="nu-sub">${esc(yours)} your time${track ? ` · ${esc(track)} at the track` : ''}</div>
        </div>
        ${w ? `<div class="nu-wx ${v?.cls || ''}">
          <div class="nu-k">Forecast for the start</div>
          <div class="nu-wx-main">${w.rainChance >= 35 ? DROP : ''}<b>${Math.round(w.temp)}°</b><span>${w.rainChance ?? '–'}% chance of rain${w.rain > 0 ? ` · ${w.rain} mm/h` : ''}</span></div>
          <div class="nu-wx-sub">Wind ${Math.round(w.wind ?? 0)} km/h · cloud ${w.cloud ?? '–'}%${(w.later || []).length ? ` · next 2 h: ${w.later.map((x) => `${x.rainChance ?? '–'}%`).join(', ')} rain` : ''}</div>
          ${v ? `<div class="nu-verdict">${esc(v.text)}</div>` : ''}
        </div>` : ''}
      </div>` : `<div class="nu-top"><div class="nu-when"><div class="nu-k">No live session right now</div><div class="nu-title">${d ? 'No upcoming session found' : 'Loading the schedule…'}</div></div></div>`;

    const grid = d?.grid ? this.#grid(d.grid) : '';
    const last = !lastName ? '' : over
      ? `<div class="nu-last">${esc(lastName)} is over. <button class="btn" data-hub="show">Show ${esc(lastName)} timing</button></div>`
      : `<div class="nu-last">Timing fills in once the session starts. <button class="btn" data-hub="show">Show the timing now</button></div>`;
    el.innerHTML = `<div class="nu">${top}${grid}${last}
      <div class="actions"><button class="btn" data-open-replays>Watch a replay</button><button class="btn" data-hub="demo">Try the demo race</button></div></div>`;
  }

  #driver(row) {
    const live = this.store.state.DriverList?.[row.num];
    const d = row.driver || {};
    // Prefer the feed's own entry (it has the current photo); OpenF1 otherwise.
    return live?.Tla ? live : { RacingNumber: row.num, Tla: d.tla, TeamName: d.team, TeamColour: d.colour, HeadshotUrl: d.headshot, FullName: `${d.first || ''} ${d.last || ''}`.trim() };
  }

  #grid(g) {
    const sel = this.store.selected;
    const s = this.store.state;
    const raceState = sessionKind(s) === 'race' && !sessionOver(s, this.store.dataNow());
    const slots = g.rows.map((r) => {
      const d = this.#driver(r);
      const pen = r.reason && !r.reason.inherited && r.change !== 0;
      const chg = r.change > 0 ? `<span class="nu-chg up" title="Qualified P${r.quali}">▲${r.change}</span>`
        : r.change < 0 ? `<span class="nu-chg down" title="Qualified P${r.quali}">▼${-r.change}</span>` : '<span class="nu-chg">–</span>';
      const stint = raceState ? currentStint(s, r.num) : null; // starting tyre, once the race session is live
      return `<div class="nu-slot ${r.pos % 2 ? 'gl' : 'gr'}${sel === r.num ? ' mine' : ''}${pen ? ' pen' : ''}" data-select="${esc(r.num)}" style="--tc:#${esc(d.TeamColour || '777')}" title="${esc(d.FullName || d.Tla || '')}${r.quali ? ` · qualified P${r.quali}` : ''}${r.reason?.text ? ` · ${r.reason.text}` : ''}">
        <span class="nu-pos">${r.pos}</span>${avatar(d, 'av')}<span class="nu-who"><b>${esc(d.Tla || r.num)}</b><small>${esc(d.TeamName || '')}</small></span>
        ${stint?.Compound ? `<span class="tyre ${esc(stint.Compound)}" title="Starting tyre: ${esc(stint.Compound.toLowerCase())}">${esc(compoundLetter(stint.Compound))}</span>` : ''}${chg}</div>`;
    }).join('');
    const moved = g.rows.filter((r) => r.reason && !r.reason.inherited && r.change !== 0 || r.change < 0);
    const ups = g.rows.filter((r) => r.reason?.inherited).length;
    const why = moved.length ? `<div class="nu-why"><h4>Why the grid differs from ${esc(g.from.toLowerCase())}</h4>
        ${moved.map((r) => {
          const d = this.#driver(r);
          const what = [r.reason?.what, r.reason?.why].filter(Boolean).join(' · ') || 'Moved back';
          return `<div class="nu-wrow" data-select="${esc(r.num)}">${avatar(d, 'av av-sm')}<b>${esc(d.Tla || r.num)}</b><span class="nu-from">${r.quali ? `P${r.quali} → P${r.pos}` : `P${r.pos}`}</span><em>${esc(what)}</em></div>`;
        }).join('')}
        ${ups ? `<p class="nu-note">${ups} other driver${ups > 1 ? 's' : ''} moved up because of these penalties.</p>` : ''}
        ${g.note ? `<p class="nu-note">F1: “${esc(g.note)}”</p>` : ''}
      </div>` : `<p class="nu-note">${g.status === 'official' ? `Same order as ${esc(g.from.toLowerCase())}.` : ''}</p>`;
    return `<div class="nu-sec"><h4>${g.for === 'Sprint' ? 'Sprint grid' : 'Starting grid'}</h4>
        <span class="tag${g.status === 'official' ? ' ok' : ''}">${g.status === 'official' ? 'After penalties' : 'Provisional · qualifying order'}</span>
        <span class="muted nu-src">from ${esc(g.from)}${g.status !== 'official' ? ' · penalties may still change it' : ''}</span></div>
      <div class="nu-gridwrap"><div class="nu-line" aria-hidden="true"></div><div class="nu-grid">${slots}</div></div>${why}`;
  }

  frame() {
    const cd = this.el && !this.el.hidden ? this.el.querySelector('.nu-cd') : null;
    if (!cd) return;
    const ms = Number(cd.dataset.to) - Date.now();
    const txt = countdown(ms);
    if (cd.textContent !== txt) cd.textContent = txt;
    // Once it has started (or the time is past), check what's next again.
    if (ms < -60000 && Date.now() - this.fetchedAt > 60000) this.load(true);
  }
}
