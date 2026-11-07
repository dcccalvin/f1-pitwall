// Timing tower: one absolutely-positioned row per car so position changes slide.
// Columns are user-selectable and auto-hide by priority when the panel is narrow.
import { esc, teamColor, sessionKind, segClass, driverOrder, currentStint, compoundLetter, parseLap } from '../format.js';

// prio: higher = kept longer when space runs out. min = px needed.
const COLUMNS = [
  { id: 'pos', label: 'Pos', w: '38px', min: 38, fixed: true },
  { id: 'delta', label: '+/−', w: '34px', min: 34, prio: 3, race: true, title: 'Places gained since the start' },
  { id: 'driver', label: 'Driver', w: 'minmax(116px, 1.35fr)', min: 116, fixed: true },
  { id: 'tyre', label: 'Tyre', w: '58px', min: 58, prio: 8 },
  { id: 'gap', label: 'Gap', w: '78px', min: 78, prio: 10 },
  { id: 'int', label: 'Int', w: '82px', min: 82, prio: 9 },
  { id: 'last', label: 'Last lap', w: '84px', min: 84, prio: 7 },
  { id: 'best', label: 'Best lap', w: '84px', min: 84, prio: 4 },
  { id: 'sectors', label: 'Sectors', w: 'repeat(3, minmax(58px, 0.8fr))', min: 180, prio: 5 },
  { id: 'speed', label: 'Trap', w: '46px', min: 46, prio: 1, title: 'Speed trap (km/h)', off: true },
  { id: 'pits', label: 'Pit', w: '38px', min: 38, prio: 2 },
];
const LABELS = { delta: 'Places gained', tyre: 'Tyre & age', gap: 'Gap to leader', int: 'Interval', last: 'Last lap', best: 'Best lap', sectors: 'Sector times', minis: 'Mini-sectors', speed: 'Speed trap', pits: 'Pit stops / laps' };

export class Tower {
  constructor(store) {
    this.store = store;
    this.root = document.querySelector('#w-tower .tower');
    this.head = document.getElementById('tower-head');
    this.body = document.getElementById('tower-body');
    this.empty = document.getElementById('empty');
    this.pop = document.getElementById('cols-pop');
    this.rows = new Map();
    this.kind = null;
    this.prefs = { ...Object.fromEntries(COLUMNS.filter((c) => !c.fixed).map((c) => [c.id, !c.off])), minis: true, autofit: true, autoheight: true, ...JSON.parse(localStorage.getItem('towerCols') || '{}') };
    this.rowH = null;
    this.colKey = '';
    this.body.addEventListener('click', (e) => {
      const row = e.target.closest('.tw-row');
      if (row) store.select(row.dataset.num, { open: matchMedia('(max-width: 900px)').matches });
    });
    this.head.addEventListener('click', (e) => { if (e.target.closest('.toggle')) document.body.classList.toggle('show-int'); });
    document.getElementById('cols-btn').addEventListener('click', (e) => { e.stopPropagation(); this.#openCols(e.currentTarget); });
    document.addEventListener('pointerdown', (e) => { if (!this.pop.hidden && !this.pop.contains(e.target) && !e.target.closest('#cols-btn')) this.pop.hidden = true; });
    new ResizeObserver(() => this.#fit()).observe(this.root);
  }

  #openCols(btn) {
    const rows = Object.entries(LABELS).map(([id, label]) => `<label class="chk"><input type="checkbox" data-c="${id}" ${this.prefs[id] ? 'checked' : ''}><span></span>${label}</label>`).join('');
    this.pop.innerHTML = `<div class="pop-title">Timing columns</div>${rows}
      <div class="menu-sep"></div><label class="chk"><input type="checkbox" data-c="autofit" ${this.prefs.autofit ? 'checked' : ''}><span></span>Auto-hide columns when narrow</label>
      <label class="chk"><input type="checkbox" data-c="autoheight" ${this.prefs.autoheight ? 'checked' : ''}><span></span>Fit every car to the panel height</label>`;
    const r = btn.getBoundingClientRect();
    this.pop.hidden = false;
    this.pop.style.top = `${r.bottom + 6}px`;
    this.pop.style.left = `${Math.max(8, Math.min(window.innerWidth - this.pop.offsetWidth - 8, r.right - this.pop.offsetWidth))}px`;
    this.pop.onchange = (e) => {
      const c = e.target.dataset.c;
      if (!c) return;
      this.prefs[c] = e.target.checked;
      localStorage.setItem('towerCols', JSON.stringify(this.prefs));
      this.#fit();
    };
  }

  /** Row height: fill the panel so every car is visible (within density limits). */
  #fitHeight() {
    const scroll = this.root.querySelector('.tower-scroll');
    const n = this.rows.size;
    if (!this.prefs.autoheight || !n || !scroll.clientHeight || matchMedia('(max-width: 900px)').matches) {
      if (this.rowH != null) { this.rowH = null; this.root.style.removeProperty('--row-h'); }
      return;
    }
    const [lo, hi] = { compact: [25, 34], comfortable: [30, 46], large: [40, 64] }[document.body.dataset.density] || [30, 46];
    const rh = Math.max(lo, Math.min(hi, Math.floor(scroll.clientHeight / n)));
    if (rh !== this.rowH) { this.rowH = rh; this.root.style.setProperty('--row-h', `${rh}px`); }
  }

  /** Decide visible columns from prefs, session type and available width. */
  #fit() {
    this.#fitHeight();
    const kind = this.kind || 'race';
    let cols = COLUMNS.filter((c) => c.fixed || (this.prefs[c.id] && !(c.race && kind !== 'race')));
    if (this.prefs.autofit && !matchMedia('(max-width: 900px)').matches) {
      const avail = this.root.clientWidth - 24;
      const need = () => cols.reduce((a, c) => a + c.min + 6, 0);
      const drop = cols.filter((c) => !c.fixed).sort((a, b) => a.prio - b.prio);
      while (need() > avail && drop.length) { const d = drop.shift(); cols = cols.filter((c) => c !== d); }
    }
    const ids = new Set(cols.map((c) => c.id));
    const key = [...ids].join() + (this.prefs.minis ? '+m' : '');
    if (key === this.colKey) return;
    this.colKey = key;
    this.root.style.setProperty('--cols', cols.map((c) => c.w).join(' '));
    for (const c of COLUMNS) this.root.classList.toggle(`hide-${c.id}`, !ids.has(c.id));
    this.root.classList.toggle('no-minis', !this.prefs.minis);
  }

  #renderHead(kind) {
    const pitLabel = kind === 'race' ? 'Pit' : 'Laps';
    this.head.innerHTML = `
      <div class="c-pos">Pos</div><div class="c-delta" title="Places gained since the start">+/−</div><div class="c-driver">Driver</div>
      <div class="c-tyre">Tyre</div><div class="c-gap r toggle">${kind === 'race' ? 'Gap' : 'Gap'}</div><div class="c-int r toggle">Int</div>
      <div class="c-last r">Last</div><div class="c-best r">Best</div>
      <div class="c-sec r">S1</div><div class="c-sec r">S2</div><div class="c-sec r">S3</div>
      <div class="c-speed r" title="Speed trap km/h">Trap</div><div class="c-pits c">${pitLabel}</div>`;
  }

  #row(num) {
    let r = this.rows.get(num);
    if (r) return r;
    const e = document.createElement('div');
    e.className = 'tw-row';
    e.dataset.num = num;
    e.innerHTML = `
      <div class="c-pos"><span class="posn"></span></div>
      <div class="c-delta"></div>
      <div class="c-driver"><span class="d-tla"></span><span class="d-num"></span><span class="d-name"></span><span class="d-badge" hidden></span></div>
      <div class="c-tyre"><span class="tyre"></span><span class="tyre-age"></span></div>
      <div class="c-num c-gap r"></div>
      <div class="c-num c-int r"></div>
      <div class="c-num c-last r"></div>
      <div class="c-num c-best r"></div>
      <div class="c-sec"><div class="segs"></div><div class="sec-v"></div></div>
      <div class="c-sec"><div class="segs"></div><div class="sec-v"></div></div>
      <div class="c-sec"><div class="segs"></div><div class="sec-v"></div></div>
      <div class="c-num c-speed r"></div>
      <div class="c-pits"></div>`;
    this.body.appendChild(e);
    const q = (s) => e.querySelector(s);
    r = {
      el: e, cache: {},
      pos: q('.posn'), delta: q('.c-delta'), num: q('.d-num'), tla: q('.d-tla'), name: q('.d-name'), badge: q('.d-badge'),
      tyre: q('.tyre'), age: q('.tyre-age'), gap: q('.c-gap'), int: q('.c-int'), last: q('.c-last'), best: q('.c-best'),
      sectors: [...e.querySelectorAll('.c-sec')].map((s) => ({ segs: s.querySelector('.segs'), v: s.querySelector('.sec-v') })),
      speed: q('.c-speed'), pits: q('.c-pits'),
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
    if (kind !== this.kind) { this.kind = kind; this.#renderHead(kind); this.colKey = ''; }
    document.body.dataset.kind = kind;
    this.#fit();

    const order = driverOrder(s);
    const lines = s.TimingData?.Lines || {};
    const drivers = s.DriverList || {};
    const app = s.TimingAppData?.Lines || {};
    const rowH = this.rowH ?? (parseFloat(getComputedStyle(this.root).getPropertyValue('--row-h')) || 36);

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
      r.el.classList.toggle('p1', i === 0);

      const pos = l.Position || String(i + 1);
      this.#set(r, 'pos', r.pos, l.ShowPosition === false ? '' : esc(pos), `posn${i < 3 ? ` podium p${i + 1}` : ''}`);

      if (kind === 'race') {
        const grid = Number(app[num]?.GridPos);
        const delta = grid ? grid - Number(pos) : null;
        this.#set(r, 'delta', r.delta, delta == null ? '' : delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : '–', `c-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}`);
      }

      if (r.cache.tc !== d.TeamColour) { r.cache.tc = d.TeamColour; r.el.style.setProperty('--tc', teamColor(d)); }
      this.#set(r, 'num', r.num, esc(d.RacingNumber || num), 'd-num');
      this.#set(r, 'tla', r.tla, esc(d.Tla || num), 'd-tla');
      this.#set(r, 'name', r.name, esc(d.LastName || ''), 'd-name');

      let badge = '', bcls = 'd-badge';
      if (l.Retired) { badge = kind === 'race' ? 'DNF' : 'OUT'; bcls += ' out'; }
      else if (l.KnockedOut) { badge = 'OUT'; bcls += ' ko'; }
      else if (l.Stopped) { badge = 'STOP'; bcls += ' out'; }
      else if (l.InPit) badge = 'PIT';
      else if (l.PitOut) { badge = 'OUT LAP'; bcls += ' outlap'; }
      if (r.cache.badge !== badge + bcls) { r.cache.badge = badge + bcls; r.badge.hidden = !badge; r.badge.textContent = badge; r.badge.className = bcls; }

      const st = currentStint(s, num);
      const comp = st?.Compound || 'UNKNOWN';
      const isNew = st?.New === 'true' || st?.New === true;
      this.#set(r, 'tyre', r.tyre, compoundLetter(comp), `tyre ${comp}${isNew ? ' new' : ''}`);
      this.#set(r, 'age', r.age, st?.TotalLaps != null ? `${st.TotalLaps}<small>L</small>` : '', 'tyre-age');

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
      const iv = parseLap(String(int).replace('+', ''));
      const attack = kind === 'race' && !isLead && iv != null && iv < 1.0 && !l.InPit;
      const gapHtml = isLead ? `<span class="lead">${kind === 'race' ? 'Leader' : (esc(gap) || 'Fastest')}</span>` : esc(gap);
      const intHtml = isLead ? (kind === 'race' ? `<span class="lead">${esc(String(gap).replace(/^LAP\s*/i, 'Lap '))}</span>` : '') : `<span class="iv">${esc(int)}</span>`;
      this.#set(r, 'gap', r.gap, gapHtml, 'c-num c-gap r');
      this.#set(r, 'int', r.int, intHtml, `c-num c-int r${catching && !isLead ? ' catching' : ''}${attack ? ' attack' : ''}`);

      // laps
      const last = l.LastLapTime || {};
      const lastCls = last.OverallFastest ? ' purple' : last.PersonalFastest ? ' green' : '';
      this.#set(r, 'last', r.last, esc(last.Value || ''), `c-num c-last r${lastCls}`, true);
      let best = l.BestLapTime?.Value || '';
      if (kind === 'quali') {
        const bl = Array.isArray(l.BestLapTimes) ? l.BestLapTimes : Object.values(l.BestLapTimes || {});
        best = bl[part - 1]?.Value || best;
      }
      const fastest = this.store.fastestLap === best && best;
      this.#set(r, 'best', r.best, esc(best), `c-num c-best r${fastest ? ' purple' : ''}`);

      // sectors + mini sectors
      const secs = Array.isArray(l.Sectors) ? l.Sectors : Object.values(l.Sectors || {});
      for (let k = 0; k < 3; k++) {
        const sec = secs[k] || {};
        const segs = Array.isArray(sec.Segments) ? sec.Segments : Object.values(sec.Segments || {});
        this.#set(r, `seg${k}`, r.sectors[k].segs, segs.map((g) => `<i class="${segClass(g?.Status)}"></i>`).join(''), 'segs');
        const vc = sec.OverallFastest ? ' purple' : sec.PersonalFastest ? ' green' : '';
        this.#set(r, `sec${k}`, r.sectors[k].v, esc(sec.Value || ''), `sec-v${vc}`, true);
      }

      const sp = l.Speeds?.ST;
      this.#set(r, 'speed', r.speed, esc(sp?.Value || ''), `c-num c-speed r${sp?.OverallFastest ? ' purple' : sp?.PersonalFastest ? ' green' : ''}`);
      const pits = kind === 'race' ? (l.NumberOfPitStops ?? '') : (l.NumberOfLaps ?? '');
      this.#set(r, 'pits', r.pits, esc(String(pits)), 'c-pits');
    });

    for (const [num, r] of this.rows) if (!seen.has(num)) { r.el.remove(); this.rows.delete(num); }
    this.body.style.height = `${order.length * rowH}px`;
  }
}
