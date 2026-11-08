// Moments: a "what just happened" feed derived from the timing data —
// overtakes, fastest laps, pit stops, retirements, flags and penalties.
import { esc, teamColor, sessionKind, sessionLocalTime } from '../format.js';

const ICON = {
  pass: '<svg viewBox="0 0 24 24"><path d="M5 17 12 7l7 10" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fast: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 9v4l2.5 2M9.5 2.5h5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  pit: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M12 10v4M12 17v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};
const TS = { 1: ['green', 'Green flag · track clear'], 2: ['yellow', 'Yellow flag'], 4: ['sc', 'Safety car deployed'], 5: ['red', 'Red flag'], 6: ['sc', 'Virtual safety car'], 7: ['sc', 'VSC ending'] };

export class Moments {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('moments');
    this.items = [];
    this.prev = new Map(); // num -> {pos, inPit, retired, stints}
    this.track = null;
    this.seq = 0;
    this.drawn = -1;
  }

  reset(state, at) {
    this.live = false; setTimeout(() => { this.live = true; }, 1500); // no pop-ups for the catch-up burst
    this.items = this.items.filter((m) => m.t <= at);
    this.prev.clear();
    for (const [num, l] of Object.entries(state?.TimingData?.Lines || {})) {
      if (!l || typeof l !== 'object') continue;
      const st = state.TimingAppData?.Lines?.[num]?.Stints;
      this.prev.set(num, { pos: Number(l.Position), inPit: !!l.InPit, retired: !!l.Retired, stints: st ? Object.keys(st).length : 0 });
    }
    this.track = state?.TrackStatus?.Status ?? null;
    const ss = state?.SessionStatus || {};
    this.session = ss.Status ?? null;
    this.everStarted = ss.Started === 'Started' || ['Started', 'Aborted', 'Finished', 'Finalised', 'Ends'].includes(ss.Status);
    this.rain = state?.WeatherData ? Number(state.WeatherData.Rainfall) > 0 : undefined;
    this.drawn = -1;
  }

  /** A note from elsewhere in the app (e.g. the lap-time weather signals). */
  note(t, state, text, cls = 'rain') {
    this.#add(t, state, { kind: 'flag', cls, text: esc(text) });
    this.drawn = -1;
  }

  #add(t, state, m) {
    // In a replay the clock that matters is the one in the recording.
    const when = this.store.status?.mode === 'replay' ? this.store.dataNow() : t;
    this.items.push({ ...m, t, id: ++this.seq, lap: state.LapCount?.CurrentLap, utc: new Date(when).toISOString() });
    if (this.items.length > 120) this.items.shift();
    // Pop-up for the driver you're following.
    const sel = this.store.selected;
    if (this.store.alerts && sel && (m.num === sel || m.d2?.num === sel) && this.live) {
      const plain = String(m.text).replace(/<[^>]+>/g, '');
      const who = m.d ? (m.kind === 'pass' ? `${m.d.tla} passes ${m.d2.tla} ` : `${m.d.tla} `) : '';
      this.store.toast(`${who}${plain}`, m.kind === 'out' || m.kind === 'pen' ? 'red' : 'driver', () => this.store.select(sel, { reveal: true, toggle: false }));
    }
  }

  onMessage(t, topic, data, state) {
    const race = sessionKind(state) === 'race';
    const dl = state.DriverList || {};
    const lines = state.TimingData?.Lines || {};
    const who = (n) => ({ num: n, tla: dl[n]?.Tla || n, color: teamColor(dl[n]) });

    if (topic === 'TrackStatus' && data?.Status && data.Status !== this.track) {
      this.track = data.Status;
      const ts = TS[data.Status];
      if (ts && !(data.Status === '1' && !race)) this.#add(t, state, { kind: 'flag', cls: ts[0], text: ts[1] });
    }

    if (topic === 'SessionStatus' && data?.Status) {
      // Lights out: the race goes from Inactive to Started (the formation lap is not 'Started').
      if (race && data.Status === 'Started' && this.session && this.session !== 'Started') {
        this.#add(t, state, { kind: 'flag', cls: 'green', text: this.everStarted ? 'The race restarts' : 'Lights out · the race is on' });
      }
      if (data.Status === 'Started') this.everStarted = true;
      this.session = data.Status;
    }

    if (topic === 'WeatherData' && data?.Rainfall !== undefined) {
      const raining = Number(data.Rainfall) > 0;
      if (this.rain !== undefined && raining !== this.rain) this.#add(t, state, { kind: 'flag', cls: 'rain', text: raining ? 'Rain is falling at the track' : 'Rain has stopped' });
      this.rain = raining;
    }

    if (topic === 'RaceControlMessages') {
      const msgs = Array.isArray(data?.Messages) ? data.Messages : Object.values(data?.Messages || {});
      for (const m of msgs) if (m && /EXTRA FORMATION LAP|START (PROCEDURE )?(HAS BEEN |IS )?ABORTED|ABORTED START|START (HAS BEEN |IS )?(DELAYED|POSTPONED)|DELAYED START|(START|FORMATION LAPS?) BEHIND THE SAFETY CAR|RACE DISTANCE|LAPS? REDUCED/i.test(m.Message || '')) this.#add(t, state, { kind: 'flag', cls: 'yellow', text: esc(m.Message) });
      for (const m of msgs) if (m && /PENALTY|DISQUALIF/.test(m.Message || '')) this.#add(t, state, { kind: 'pen', cls: 'pen', text: esc(m.Message.replace(/^FIA STEWARDS:\s*/, '')) });
      for (const m of msgs) if (m && /WILL (RESUME|RESTART|START) AT|WILL NOT RESUME/i.test(m.Message || '')) this.#add(t, state, { kind: 'flag', cls: 'resume', text: esc(m.Message) + ' (track time)' });    }

    if (topic === 'PitLaneTimeCollection') {
      for (const [num, p] of Object.entries(data?.PitTimes || {})) {
        const m = [...this.items].reverse().find((x) => x.kind === 'pit' && x.num === num && t - x.t < 120000);
        if (m && p?.Duration) { m.lane = p.Duration; this.drawn = -1; }
      }
    }

    if (topic === 'TimingAppData' && race) {
      for (const [num, l] of Object.entries(data?.Lines || {})) {
        if (!l?.Stints) continue;
        const all = state.TimingAppData?.Lines?.[num]?.Stints;
        const count = all ? Object.keys(all).length : 0;
        const p = this.prev.get(num) || {};
        if (count > (p.stints || 0) && p.stints) {
          const st = Array.isArray(all) ? all.at(-1) : all[Math.max(...Object.keys(all).map(Number))];
          const m = [...this.items].reverse().find((x) => x.kind === 'pit' && x.num === num && t - x.t < 120000);
          if (m && st?.Compound) { m.tyre = `${st.New === 'true' ? 'new ' : 'used '}${st.Compound.toLowerCase()}s`; this.drawn = -1; }
        }
        this.prev.set(num, { ...p, stints: count });
      }
    }

    if (topic !== 'TimingData' || !data?.Lines) return;
    const sc = ['4', '5', '6', '7'].includes(String(state.TrackStatus?.Status));
    const moved = [];
    for (const [num, l] of Object.entries(data.Lines)) {
      if (!l || typeof l !== 'object') continue;
      const p = this.prev.get(num) || { pos: Number(lines[num]?.Position), inPit: false, retired: false, stints: 0 };
      const cur = lines[num] || {};
      if (l.Position !== undefined) moved.push([num, p.pos, Number(l.Position)]);
      if (race && l.InPit === true && !p.inPit) this.#add(t, state, { kind: 'pit', cls: 'pit', num, d: who(num), text: `pits from P${esc(cur.Position)}` });
      if (race && (l.Retired === true || l.Stopped === true) && !p.retired) this.#add(t, state, { kind: 'out', cls: 'out', num, d: who(num), text: l.Retired ? 'retires from the race' : 'has stopped on track' });
      if (l.LastLapTime?.OverallFastest && l.LastLapTime?.Value) {
        this.#add(t, state, { kind: 'fast', cls: 'fast', num, d: who(num), text: race ? `sets the fastest lap · <b class="num">${esc(l.LastLapTime.Value)}</b>` : `goes quickest · <b class="num">${esc(l.LastLapTime.Value)}</b>` });
      }
      this.prev.set(num, { ...p, inPit: l.InPit ?? p.inPit, retired: p.retired || !!l.Retired || !!l.Stopped, pos: l.Position !== undefined ? Number(l.Position) : p.pos });
    }
    // Overtakes: a car gains a place from a car that dropped one, both on track.
    if (race && !sc) {
      for (const [num, from, to] of moved) {
        if (!(to < from)) continue;
        const victim = moved.find(([n, f, tt]) => n !== num && f === to && tt > f);
        if (!victim) continue;
        const vl = lines[victim[0]] || {}, ml = lines[num] || {};
        if (vl.InPit || vl.PitOut || vl.Retired || vl.Stopped || ml.PitOut || ml.InPit) continue;
        this.#add(t, state, { kind: 'pass', cls: 'pass', num, d: who(num), d2: who(victim[0]), text: `for P${to}` });
      }
    }
  }

  update() {
    if (this.drawn === this.seq && this.items.length && this.drawnSel === this.store.selected) return;
    this.drawnSel = this.store.selected;
    const fresh = this.drawn >= 0 ? this.items.filter((m) => m.id > this.drawn).length : 0;
    this.drawn = this.seq;
    const off = this.store.state.SessionInfo?.GmtOffset;
    if (!this.items.length) {
      this.root.innerHTML = '<div class="feed-empty"><b>Nothing yet.</b><br>Overtakes, pit stops, fastest laps and flags will appear here as they happen.</div>';
      return;
    }
    const chip = (d) => `<span class="dchip" style="--tc:${d.color}" data-select="${esc(d.num)}" title="Follow ${esc(d.tla)}">${esc(d.tla)}</span>`;
    this.root.innerHTML = this.items.slice().reverse().map((m, i) => {
      let body = '';
      if (m.kind === 'pass') body = `${chip(m.d)} passes ${chip(m.d2)} ${m.text}`;
      else if (m.kind === 'pit') body = `${chip(m.d)} ${m.text}${m.tyre ? ` · on ${esc(m.tyre)}` : ''}${m.lane ? ` · lane <b class="num">${esc(m.lane)}s</b>` : ''}`;
      else if (m.d) body = `${chip(m.d)} ${m.text}`;
      else body = m.text;
      const mine = this.store.selected && (m.num === this.store.selected || m.d2?.num === this.store.selected);
      return `<div class="moment ${m.cls}${i < fresh ? ' fresh' : ''}${mine ? ' mine' : ''}">
        <span class="m-ico">${ICON[m.kind] || ICON.flag}</span>
        <div class="m-body">${body}</div>
        <div class="m-time">${m.lap ? `L${esc(m.lap)} · ` : ''}${esc(sessionLocalTime(m.utc, off).slice(0, 5))}</div>
      </div>`;
    }).join('');
    if (fresh > 0) this.store.notify('moments');
  }
}
