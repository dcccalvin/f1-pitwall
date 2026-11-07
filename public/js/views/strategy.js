// Tyre strategy: one bar per driver across the race, coloured by compound.
import { esc, teamColor, driverOrder, stintList, compoundLetter, sessionKind } from '../format.js';

export class Strategy {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('strategy');
    this.key = '';
  }

  update() {
    const s = this.store.state;
    const order = driverOrder(s);
    if (!order.length) { this.root.innerHTML = '<div class="feed-empty">Waiting for tyre data…</div>'; this.key = ''; return; }
    const kind = sessionKind(s);
    const dl = s.DriverList || {};
    const lines = s.TimingData?.Lines || {};

    const rows = order.map((num) => {
      let start = 0;
      const stints = stintList(s, num).map((st) => {
        const laps = Math.max(0, (Number(st.TotalLaps) || 0) - (Number(st.StartLaps) || 0));
        const o = { from: start, laps, comp: st.Compound || 'UNKNOWN', isNew: st.New === 'true' || st.New === true };
        start += laps;
        return o;
      });
      return { num, stints, total: start };
    });
    const current = Number(s.LapCount?.CurrentLap) || 0;
    const scale = Math.max(kind === 'race' ? Number(s.LapCount?.TotalLaps) || 0 : 0, ...rows.map((r) => r.total), current, 10);

    const key = JSON.stringify([rows, scale, current]);
    if (key === this.key) return;
    this.key = key;

    const step = scale > 50 ? 10 : 5;
    const ticks = [];
    for (let l = 0; l <= scale; l += step) ticks.push(`<span style="left:${(l / scale) * 100}%">${l}</span>`);

    this.root.innerHTML = `
      <div class="st-axis"><span>Lap</span><div class="ticks">${ticks.join('')}</div><span></span></div>
      ${rows.map((r) => {
        const d = dl[r.num] || {};
        const stops = kind === 'race' ? (lines[r.num]?.NumberOfPitStops ?? Math.max(0, r.stints.length - 1)) : '';
        return `<div class="st-row">
          <div class="tla"><i style="background:${teamColor(d)}"></i>${esc(d.Tla || r.num)}</div>
          <div class="st-track">
            ${r.stints.map((st) => `<div class="st-stint ${esc(st.comp)}${st.isNew ? '' : ' used'}" style="left:${(st.from / scale) * 100}%;width:max(${(st.laps / scale) * 100}%, 6px)" title="${esc(st.comp)} · ${st.laps} laps${st.isNew ? '' : ' (used set)'}">${st.laps >= scale * 0.06 ? compoundLetter(st.comp) : ''}</div>`).join('')}
            ${kind === 'race' && current ? `<div class="st-now" style="left:${(Math.min(current, scale) / scale) * 100}%"></div>` : ''}
          </div>
          <div class="stops" title="Pit stops">${stops === '' ? '' : `${stops}`}</div>
        </div>`;
      }).join('')}
      <div class="st-legend">
        <span><i style="background:var(--tyre-soft)"></i>Soft</span><span><i style="background:var(--tyre-medium)"></i>Medium</span>
        <span><i style="background:var(--tyre-hard)"></i>Hard</span><span><i style="background:var(--tyre-inter)"></i>Inter</span>
        <span><i style="background:var(--tyre-wet)"></i>Wet</span><span><i style="background:var(--text-3);background-image:repeating-linear-gradient(135deg,rgba(0,0,0,.35) 0 3px,transparent 3px 7px)"></i>Used set</span>
      </div>`;
  }
}
