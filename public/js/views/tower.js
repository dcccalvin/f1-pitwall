// Timing tower: one absolutely-positioned row per car so position changes slide.
import { esc, teamColor, sessionKind, segClass, driverOrder, currentStint, compoundLetter } from '../format.js';

const HEADS = {
  race: ['Pos', '', 'Driver', 'Tyre', 'Gap', 'Int', 'Last', 'Best', 'S1', 'S2', 'S3', 'Pit'],
  practice: ['Pos', '', 'Driver', 'Tyre', 'Gap', 'Int', 'Last', 'Best', 'S1', 'S2', 'S3', 'Laps'],
  quali: ['Pos', '', 'Driver', 'Tyre', 'Gap', 'Int', 'Last', 'Best', 'S1', 'S2', 'S3', 'Laps'],
};
const HEAD_CLS = ['c', 'c-delta', 'c-driver', 'c-tyre', 'r c-gap', 'r c-int', 'r c-last', 'r c-best', 'r c-sector', 'r c-sector', 'r c-sector', 'c c-pits'];

export class Tower {
  constructor(store) {
    this.store = store;
    this.head = document.getElementById('tower-head');
    this.body = document.getElementById('tower-body');
    this.empty = document.getElementById('empty');
    this.rows = new Map();
    this.kind = null;
    this.body.addEventListener('click', (e) => {
      const row = e.target.closest('.tw-row');
      if (row) store.select(row.dataset.num, { open: matchMedia('(max-width: 900px)').matches });
    });
    this.head.addEventListener('click', (e) => {
      if (e.target.closest('.toggle')) { document.body.classList.toggle('show-int'); }
    });
  }

  #renderHead(kind) {
    const labels = HEADS[kind];
    this.head.innerHTML = labels.map((l, i) => {
      const toggle = (i === 4 || i === 5) ? ' toggle' : '';
      return `<div class="${HEAD_CLS[i]}${toggle}">${l}</div>`;
    }).join('');
  }

  #row(num) {
    let r = this.rows.get(num);
    if (r) return r;
    const e = document.createElement('div');
    e.className = 'tw-row';
    e.dataset.num = num;
    e.innerHTML = `
      <div class="c-pos c-num"></div>
      <div class="c-delta"></div>
      <div class="c-driver"><i class="team-bar"></i><span class="d-num"></span><span class="d-tla"></span><span class="d-name"></span><span class="d-badge" hidden></span></div>
      <div class="c-tyre"><span class="tyre"></span><span class="tyre-age"></span></div>
      <div class="c-num c-gap r"></div>
      <div class="c-num c-int r"></div>
      <div class="c-num c-last r"></div>
      <div class="c-num c-best r"></div>
      <div class="c-sector"><div class="segs"></div><div class="sec-v"></div></div>
      <div class="c-sector"><div class="segs"></div><div class="sec-v"></div></div>
      <div class="c-sector"><div class="segs"></div><div class="sec-v"></div></div>
      <div class="c-pits"></div>`;
    this.body.appendChild(e);
    const q = (s) => e.querySelector(s);
    r = {
      el: e, cache: {},
      pos: q('.c-pos'), delta: q('.c-delta'), bar: q('.team-bar'), num: q('.d-num'), tla: q('.d-tla'), name: q('.d-name'), badge: q('.d-badge'),
      tyre: q('.tyre'), age: q('.tyre-age'), gap: q('.c-gap'), int: q('.c-int'), last: q('.c-last'), best: q('.c-best'),
      sectors: [...e.querySelectorAll('.c-sector')].map((s) => ({ segs: s.querySelector('.segs'), v: s.querySelector('.sec-v') })),
      pits: q('.c-pits'),
    };
    this.rows.set(num, r);
    return r;
  }

  // Only touch the DOM when a value really changed; flash time cells on change.
  #set(r, key, node, html, cls, flash = false) {
    const k = `${html}|${cls}`;
    if (r.cache[key] === k) return;
    const had = r.cache[key] !== undefined;
    r.cache[key] = k;
    node.innerHTML = html;
    node.className = cls;
    if (flash && had && html) { node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); }
  }

  update() {
    const s = this.store.state;
    const kind = sessionKind(s);
    if (kind !== this.kind) { this.kind = kind; this.#renderHead(kind); }
    document.body.dataset.kind = kind;

    const order = driverOrder(s);
    const lines = s.TimingData?.Lines || {};
    const drivers = s.DriverList || {};
    const app = s.TimingAppData?.Lines || {};
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 33;

    this.empty.hidden = order.length > 0;
    if (!order.length) this.store.renderEmpty?.(this.empty);

    // qualifying knockout zone
    const part = Number(s.TimingData?.SessionPart) || 1;
    const entries = s.TimingData?.NoEntries;
    const total = order.length;
    const advance = kind === 'quali' && part < 3 ? (Number(entries?.[part]) || (part === 1 ? (total >= 22 ? 16 : 15) : 10)) : null;

    const seen = new Set();
    order.forEach((num, i) => {
      seen.add(num);
      const l = lines[num];
      const d = drivers[num] || {};
      const r = this.#row(num);
      r.el.style.transform = `translateY(${i * rowH}px)`;

      const out = l.Retired || l.KnockedOut || (kind !== 'race' && l.Stopped);
      r.el.classList.toggle('out', !!out);
      r.el.classList.toggle('inpit', !!l.InPit);
      r.el.classList.toggle('selected', this.store.selected === num);
      r.el.classList.toggle('danger', advance != null && i >= advance && !l.KnockedOut);
      r.el.classList.toggle('cutline', advance != null && i === advance - 1);

      const pos = l.Position || String(i + 1);
      this.#set(r, 'pos', r.pos, l.ShowPosition === false ? '' : esc(pos), 'c-pos c-num');

      if (kind === 'race') {
        const grid = Number(app[num]?.GridPos);
        const delta = grid ? grid - Number(pos) : null;
        this.#set(r, 'delta', r.delta, delta == null ? '' : delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : '–', `c-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}`);
      }

      if (r.cache.tc !== d.TeamColour) { r.cache.tc = d.TeamColour; r.bar.style.background = teamColor(d); r.el.style.setProperty('--tc', teamColor(d)); }
      this.#set(r, 'num', r.num, esc(d.RacingNumber || num), 'd-num');
      this.#set(r, 'tla', r.tla, esc(d.Tla || num), 'd-tla');
      this.#set(r, 'name', r.name, esc(d.LastName || ''), 'd-name');

      let badge = '', bcls = 'd-badge';
      if (l.Retired) { badge = kind === 'race' ? 'DNF' : 'OUT'; bcls += ' out'; }
      else if (l.KnockedOut) { badge = `OUT`; bcls += ' ko'; }
      else if (l.Stopped) { badge = 'STOP'; bcls += ' out'; }
      else if (l.InPit) badge = 'PIT';
      else if (l.PitOut) badge = 'OUT LAP';
      if (r.cache.badge !== badge + bcls) { r.cache.badge = badge + bcls; r.badge.hidden = !badge; r.badge.textContent = badge; r.badge.className = bcls; }

      const st = currentStint(s, num);
      const comp = st?.Compound || 'UNKNOWN';
      const isNew = st?.New === 'true' || st?.New === true;
      this.#set(r, 'tyre', r.tyre, compoundLetter(comp), `tyre ${comp}${isNew ? ' new' : ''}`);
      this.#set(r, 'age', r.age, st?.TotalLaps != null ? String(st.TotalLaps) : '', 'tyre-age');

      // gaps
      let gap = '', int = '', catching = false;
      if (kind === 'race') {
        gap = l.GapToLeader ?? '';
        int = l.IntervalToPositionAhead?.Value ?? '';
        catching = !!l.IntervalToPositionAhead?.Catching;
      } else if (kind === 'quali') {
        const st2 = Array.isArray(l.Stats) ? l.Stats[part - 1] : l.Stats?.[part - 1];
        gap = st2?.TimeDiffToFastest ?? l.TimeDiffToFastest ?? '';
        int = st2?.TimeDiffToPositionAhead ?? l.TimeDiffToPositionAhead ?? '';
      } else {
        gap = l.TimeDiffToFastest ?? '';
        int = l.TimeDiffToPositionAhead ?? '';
      }
      const isLead = i === 0 || /^LAP/i.test(gap);
      const gapHtml = isLead ? `<span class="lead">${kind === 'race' ? 'Leader' : esc(gap) || 'Fastest'}</span>` : esc(gap);
      const intHtml = isLead ? (kind === 'race' ? `<span class="lead">${esc(gap.replace(/^LAP\s*/i, 'Lap '))}</span>` : '') : esc(int);
      this.#set(r, 'gap', r.gap, gapHtml, 'c-num c-gap r');
      this.#set(r, 'int', r.int, intHtml, `c-num c-int r${catching && !isLead ? ' catching' : ''}`);

      // laps
      const last = l.LastLapTime || {};
      const lastCls = last.OverallFastest ? ' purple' : last.PersonalFastest ? ' green' : '';
      this.#set(r, 'last', r.last, esc(last.Value || ''), `c-num c-last r${lastCls}`, true);
      let best = l.BestLapTime?.Value || '';
      if (kind === 'quali') {
        const bl = Array.isArray(l.BestLapTimes) ? l.BestLapTimes : Object.values(l.BestLapTimes || {});
        best = bl[part - 1]?.Value || '';
      }
      const fastest = this.store.fastestLap === best && best;
      this.#set(r, 'best', r.best, esc(best), `c-num c-best r${fastest ? ' purple' : ''}`);

      // sectors + mini sectors
      const secs = Array.isArray(l.Sectors) ? l.Sectors : Object.values(l.Sectors || {});
      for (let k = 0; k < 3; k++) {
        const sec = secs[k] || {};
        const segs = Array.isArray(sec.Segments) ? sec.Segments : Object.values(sec.Segments || {});
        const segHtml = segs.map((g) => `<i class="${segClass(g?.Status)}"></i>`).join('');
        this.#set(r, `seg${k}`, r.sectors[k].segs, segHtml, 'segs');
        const v = sec.Value || '';
        const vc = sec.OverallFastest ? ' purple' : sec.PersonalFastest ? ' green' : '';
        this.#set(r, `sec${k}`, r.sectors[k].v, esc(v), `sec-v${vc}`, true);
      }

      const pits = kind === 'race' ? (l.NumberOfPitStops ?? '') : (l.NumberOfLaps ?? '');
      this.#set(r, 'pits', r.pits, esc(String(pits)), 'c-pits');
    });

    for (const [num, r] of this.rows) if (!seen.has(num)) { r.el.remove(); this.rows.delete(num); }
    this.body.style.height = `${order.length * rowH}px`;
  }
}
