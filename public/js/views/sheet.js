// Driver detail card (phone: tap a driver in the tower).
import { esc, teamColor, segClass, currentStint, stintList, compoundLetter, sessionKind } from '../format.js';

export class DriverSheet {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('sheet');
    this.num = null;
    this.root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
  }

  open(num) {
    this.num = num;
    this.root.hidden = false;
    this.update();
  }

  close() {
    this.num = null;
    this.root.hidden = true;
  }

  update() {
    if (!this.num) return;
    const s = this.store.state;
    const l = s.TimingData?.Lines?.[this.num];
    const d = s.DriverList?.[this.num] || {};
    if (!l) return this.close();
    const kind = sessionKind(s);
    const st = currentStint(s, this.num);
    const secs = Array.isArray(l.Sectors) ? l.Sectors : Object.values(l.Sectors || {});
    const gap = kind === 'race' ? l.GapToLeader : l.TimeDiffToFastest;
    const int = kind === 'race' ? l.IntervalToPositionAhead?.Value : l.TimeDiffToPositionAhead;
    const stints = stintList(s, this.num).map((x) => `<span class="tyre ${esc(x.Compound)}" title="${esc(x.Compound)}">${compoundLetter(x.Compound)}</span>`).join(' ');
    const cell = (k, v, cls = '') => `<div><div class="k">${k}</div><div class="v ${cls}">${v || '–'}</div></div>`;
    this.root.innerHTML = `
      <div class="grab" data-close></div>
      <button class="icon-btn sh-close" data-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      <div class="sh-head">
        <div class="pos">${esc(l.Position || '')}</div>
        <i class="bar" style="background:${teamColor(d)}"></i>
        <div><b>${esc(d.FullName || d.Tla || this.num)}</b><span>#${esc(d.RacingNumber || this.num)} · ${esc(d.TeamName || '')}</span></div>
      </div>
      <div class="sh-grid">
        ${cell(kind === 'race' ? 'Gap to leader' : 'Gap to fastest', esc(gap))}
        ${cell('Interval', esc(int), l.IntervalToPositionAhead?.Catching ? 'green' : '')}
        ${cell('Last lap', esc(l.LastLapTime?.Value), l.LastLapTime?.OverallFastest ? 'purple' : l.LastLapTime?.PersonalFastest ? 'green' : '')}
        ${cell('Best lap', esc(l.BestLapTime?.Value))}
        ${cell('Tyre', st ? `${esc(st.Compound)} · ${esc(st.TotalLaps)} laps` : '')}
        ${cell(kind === 'race' ? 'Pit stops' : 'Laps', esc(kind === 'race' ? l.NumberOfPitStops : l.NumberOfLaps))}
        ${cell('Speed trap', l.Speeds?.ST?.Value ? `${esc(l.Speeds.ST.Value)} km/h` : '')}
        ${cell('Finish line', l.Speeds?.FL?.Value ? `${esc(l.Speeds.FL.Value)} km/h` : '')}
        ${cell('Stints', stints)}
      </div>
      <div class="sh-sectors">
        ${[0, 1, 2].map((k) => {
          const sec = secs[k] || {};
          const segs = Array.isArray(sec.Segments) ? sec.Segments : Object.values(sec.Segments || {});
          return `<div><div class="k" style="color:var(--text-3);font-size:var(--fs-xs);letter-spacing:.1em">SECTOR ${k + 1}</div>
            <div class="segs" style="margin-top:6px">${segs.map((g) => `<i class="${segClass(g?.Status)}"></i>`).join('')}</div>
            <div class="sec-v ${sec.OverallFastest ? 'purple' : sec.PersonalFastest ? 'green' : ''}">${esc(sec.Value || '–')}</div></div>`;
        }).join('')}
      </div>`;
  }
}
