// Flexible dock layout: columns of tab groups. Panels can be dragged between
// groups (as a tab, split above/below, or into a new column), dividers resize,
// presets switch the whole arrangement. Saved per device in localStorage.
import { esc } from './format.js';

const I = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const WIDGETS = {
  tower: { title: 'Timing', short: 'Timing', icon: I('<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>') },
  map: { title: 'Track map', short: 'Map', icon: I('<path d="M7 19c-2.5 0-3.5-2.5-2-4.5l3-4c1-1.4.4-3.5 1.5-4.6C11 4.4 14 5 14.5 7c.4 1.7 1.8 2 3.3 2.2 2.6.4 3 3.3 1.2 4.8l-4.5 3.7C13 19 11 19 9 19z" stroke="currentColor" stroke-width="1.8" fill="none"/>') },
  battles: { title: 'Battles', short: 'Battles', icon: I('<path d="M5 18 15 8M15 8h-5M15 8v5M19 6l-4 4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="6" r="2.2" stroke="currentColor" stroke-width="1.6" fill="none"/>') },
  moments: { title: 'Moments', short: 'Moments', icon: I('<path d="M13 3 5 14h6l-1 7 8-11h-6z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/>') },
  control: { title: 'Race control', short: 'Control', icon: I('<path d="M6 21V4M6 4h11l-2 4 2 4H6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round" stroke-linecap="round"/>') },
  radio: { title: 'Team radio', short: 'Radio', icon: I('<rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>') },
  strategy: { title: 'Tyre strategy', short: 'Tyres', icon: I('<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8" fill="none"/><circle cx="12" cy="12" r="3.5" stroke="currentColor" stroke-width="1.8" fill="none"/>') },
  telemetry: { title: 'Car telemetry', short: 'Car', icon: I('<path d="M4 16a8 8 0 1 1 16 0" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="m12 16 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>') },
};
const LOCK = '<span class="lock" title="Needs F1 TV"><svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7V5.3a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></span>';

export const PRESETS = {
  pitwall: { name: 'Pit wall', desc: 'Timing, map and feeds', layout: { cols: [
    { w: 1.45, groups: [{ tabs: ['tower'] }] },
    { w: 1, groups: [{ h: 1.1, tabs: ['map', 'battles'] }, { h: 1, tabs: ['moments', 'control', 'radio', 'strategy', 'telemetry'] }] },
  ] } },
  engineer: { name: 'Race engineer', desc: 'Three columns, big screens', layout: { cols: [
    { w: 1.35, groups: [{ tabs: ['tower'] }] },
    { w: 1, groups: [{ h: 1.25, tabs: ['map'] }, { h: 1, tabs: ['telemetry', 'strategy'] }] },
    { w: 0.8, groups: [{ h: 1, tabs: ['battles'] }, { h: 1.3, tabs: ['moments', 'control', 'radio'] }] },
  ] } },
  timing: { name: 'Timing focus', desc: 'Wide tower, slim side bar', layout: { cols: [
    { w: 2.2, groups: [{ tabs: ['tower'] }] },
    { w: 0.85, groups: [{ h: 1, tabs: ['battles', 'map'] }, { h: 1.2, tabs: ['moments', 'control', 'radio', 'strategy', 'telemetry'] }] },
  ] } },
  map: { name: 'Map focus', desc: 'Big live track map', layout: { cols: [
    { w: 0.95, groups: [{ tabs: ['tower'] }] },
    { w: 1.3, groups: [{ h: 1.9, tabs: ['map'] }, { h: 1, tabs: ['battles', 'moments', 'control', 'radio', 'strategy', 'telemetry'] }] },
  ] } },
  sofa: { name: 'Sofa', desc: 'Large text, fewer panels', density: 'large', layout: { cols: [
    { w: 1.3, groups: [{ tabs: ['tower'] }] },
    { w: 1, groups: [{ h: 1.15, tabs: ['map'] }, { h: 1, tabs: ['battles', 'moments', 'control'] }] },
  ] } },
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const div = (cls) => { const e = document.createElement('div'); e.className = cls; return e; };

export class Layout {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('layout');
    this.parking = document.getElementById('parking');
    this.nav = document.getElementById('bottomnav');
    this.menu = document.getElementById('panel-menu');
    this.widgets = {};
    this.tools = {};
    for (const id of Object.keys(WIDGETS)) {
      this.widgets[id] = document.getElementById(`w-${id}`);
      this.tools[id] = this.widgets[id].querySelector('.w-tools');
    }
    this.dots = new Set();
    this.mq = matchMedia('(max-width: 900px)');
    this.mobileTab = localStorage.getItem('mtab') || 'tower';
    this.state = this.#load();
    this.mq.addEventListener('change', () => this.render());
    document.addEventListener('pointerdown', (e) => { if (!this.menu.hidden && !this.menu.contains(e.target) && !e.target.closest('.g-menu')) this.menu.hidden = true; });
    this.#buildNav();
    this.render();
  }

  get mobile() { return this.mq.matches; }

  #load() {
    try {
      const s = JSON.parse(localStorage.getItem('layout'));
      if (s?.cols?.length && s.cols.every((c) => c.groups?.length)) return s;
    } catch { /* fall through */ }
    const key = window.innerWidth >= 1700 ? 'engineer' : 'pitwall';
    return { ...clone(PRESETS[key].layout), preset: key };
  }

  save() { localStorage.setItem('layout', JSON.stringify(this.state)); }

  applyPreset(key) {
    const p = PRESETS[key];
    this.state = { ...clone(p.layout), preset: key };
    if (p.density) this.store.setLook({ density: p.density });
    this.save();
    this.render();
  }

  placed(id) { return this.state.cols.some((c) => c.groups.some((g) => g.tabs.includes(id))); }

  /** Is the widget on screen right now? */
  visible(id) {
    if (this.mobile) return this.mobileTab === id;
    return this.state.cols.some((c) => c.groups.some((g) => (g.active || g.tabs[0]) === id));
  }

  notify(id) {
    if (this.visible(id)) return;
    this.dots.add(id);
    this.#paintDots();
  }

  #paintDots() {
    document.querySelectorAll('[data-dot]').forEach((b) => b.classList.toggle('has-dot', this.dots.has(b.dataset.dot)));
  }

  // ---------------------------------------------------------------- render
  render() {
    for (const id of Object.keys(this.widgets)) {
      if (this.tools[id]) this.widgets[id].prepend(this.tools[id]);
      this.parking.append(this.widgets[id]);
    }
    this.root.innerHTML = '';
    this.menu.hidden = true;
    if (this.mobile) this.#renderMobile();
    else this.state.cols.forEach((col, ci) => {
      if (ci > 0) this.root.append(this.#colResizer(ci));
      const colEl = div('col');
      colEl.style.flex = `${col.w ?? 1} 1 0`;
      col.groups.forEach((g, gi) => {
        if (gi > 0) colEl.append(this.#rowResizer(ci, gi, colEl));
        colEl.append(this.#group(ci, gi, g));
      });
      this.root.append(colEl);
    });
    for (const id of Object.keys(this.widgets)) if (this.visible(id)) this.dots.delete(id);
    this.#paintDots();
    this.store.onLayout?.();
  }

  #renderMobile() {
    const id = WIDGETS[this.mobileTab] ? this.mobileTab : 'tower';
    const g = div('group mobile');
    const head = div('g-head');
    head.innerHTML = `<div class="g-title">${WIDGETS[id].icon}<span>${esc(WIDGETS[id].title)}</span></div>`;
    const tools = div('g-tools');
    if (this.tools[id]) tools.append(this.tools[id]);
    head.append(tools);
    const body = div('g-body');
    body.append(this.widgets[id]);
    g.append(head, body);
    this.root.append(g);
    this.nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.w === id));
  }

  #buildNav() {
    this.nav.innerHTML = Object.entries(WIDGETS).map(([id, w]) => `<button data-w="${id}" data-dot="${id}">${w.icon}<span>${esc(w.short)}</span>${id === 'telemetry' ? LOCK : ''}</button>`).join('');
    this.nav.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.mobileTab = b.dataset.w;
      localStorage.setItem('mtab', this.mobileTab);
      this.dots.delete(this.mobileTab);
      this.render();
      this.store.dirty?.();
    });
  }

  #group(ci, gi, g) {
    if (!g.tabs.includes(g.active)) g.active = g.tabs[0];
    const el = div('group');
    el.style.flex = `${g.h ?? 1} 1 0`;
    const head = div('g-head');
    const tabs = div('g-tabs');
    for (const id of g.tabs) {
      const w = WIDGETS[id];
      const b = document.createElement('button');
      b.className = `g-tab${id === g.active ? ' active' : ''}`;
      b.draggable = true;
      b.dataset.w = id;
      b.dataset.dot = id;
      b.title = w.title;
      b.innerHTML = `${w.icon}<span>${esc(w.title)}</span>${id === 'telemetry' ? LOCK : ''}`;
      b.addEventListener('click', () => { g.active = id; this.dots.delete(id); this.save(); this.render(); this.store.dirty?.(); });
      b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; this.dragging = id; document.body.classList.add('dragging'); });
      b.addEventListener('dragend', () => { this.dragging = null; document.body.classList.remove('dragging'); this.root.querySelectorAll('.drop-hint').forEach((h) => h.remove()); });
      tabs.append(b);
    }
    const tools = div('g-tools');
    if (this.tools[g.active]) tools.append(this.tools[g.active]);
    const menuBtn = document.createElement('button');
    menuBtn.className = 'g-menu';
    menuBtn.title = 'Panel options';
    menuBtn.innerHTML = I('<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>');
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); this.#openMenu(menuBtn, g); });
    head.append(tabs, tools, menuBtn);
    const body = div('g-body');
    body.append(this.widgets[g.active]);
    el.append(head, body);

    // drag & drop target
    el.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      this.#hint(el, this.#zone(el, head, e));
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.querySelector('.drop-hint')?.remove(); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = this.dragging || e.dataTransfer.getData('text/plain');
      const zone = this.#zone(el, head, e);
      el.querySelector('.drop-hint')?.remove();
      if (id) this.move(id, this.state.cols[ci], g, zone);
    });
    return el;
  }

  #zone(el, head, e) {
    const r = el.getBoundingClientRect();
    const hr = head.getBoundingClientRect();
    if (e.clientY <= hr.bottom) return 'tab';
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - hr.bottom) / (r.bottom - hr.bottom);
    if (x > 0.75) return 'right';
    if (x < 0.25) return 'left';
    if (y > 0.6) return 'below';
    if (y < 0.25) return 'above';
    return 'tab';
  }

  #hint(el, zone) {
    let h = el.querySelector('.drop-hint');
    if (!h) { h = div('drop-hint'); el.append(h); }
    h.dataset.zone = zone;
    h.textContent = { tab: 'Add as tab', right: 'New column', left: 'New column', below: 'Split below', above: 'Split above' }[zone];
  }

  /** Move widget `id` relative to target group `tg` in column `tc`. */
  move(id, tc, tg, zone) {
    if (zone === 'tab' && tg.tabs.includes(id)) { tg.active = id; this.save(); this.render(); return; }
    for (const c of this.state.cols) for (const g of c.groups) g.tabs = g.tabs.filter((t) => t !== id);
    if (zone === 'tab') { tg.tabs.push(id); tg.active = id; }
    else if (zone === 'below' || zone === 'above') {
      const h = (tg.h ?? 1) / 2;
      tg.h = h;
      const at = tc.groups.indexOf(tg) + (zone === 'below' ? 1 : 0);
      tc.groups.splice(at, 0, { h, tabs: [id], active: id });
    } else {
      const w = (tc.w ?? 1) / 2;
      tc.w = w;
      const at = this.state.cols.indexOf(tc) + (zone === 'right' ? 1 : 0);
      this.state.cols.splice(at, 0, { w, groups: [{ tabs: [id], active: id }] });
    }
    this.#cleanup();
    this.state.preset = null;
    this.save();
    this.render();
    this.store.dirty?.();
  }

  #cleanup() {
    for (const c of this.state.cols) c.groups = c.groups.filter((g) => g.tabs.length);
    this.state.cols = this.state.cols.filter((c) => c.groups.length);
    if (!this.state.cols.length) this.state = clone(PRESETS.pitwall.layout);
  }

  show(id, on) {
    if (on && !this.placed(id)) {
      const lastCol = this.state.cols.at(-1);
      const g = lastCol.groups.at(-1);
      g.tabs.push(id);
      g.active = id;
    } else if (!on) {
      for (const c of this.state.cols) for (const g of c.groups) g.tabs = g.tabs.filter((t) => t !== id);
      this.#cleanup();
    }
    this.state.preset = null;
    this.save();
    this.render();
    this.store.dirty?.();
  }

  #openMenu(btn, g) {
    const id = g.active;
    const col = this.state.cols.find((c) => c.groups.includes(g));
    const hidden = Object.keys(WIDGETS).filter((w) => !this.placed(w));
    this.menu.innerHTML = `
      <div class="menu-label">${esc(WIDGETS[id].title)}</div>
      <button data-act="right">${I('<rect x="3" y="4" width="8" height="16" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M15 12h6M18 9v6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>')}Move to a new column</button>
      <button data-act="below">${I('<rect x="4" y="3" width="16" height="8" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M12 15v6M9 18h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>')}Split below</button>
      ${this.state.cols.reduce((n, c) => n + c.groups.reduce((m, x) => m + x.tabs.length, 0), 0) > 1 ? `<button data-act="close">${I('<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>')}Hide this panel</button>` : ''}
      ${hidden.length ? `<div class="menu-sep"></div><div class="menu-label">Add here</div>${hidden.map((w) => `<button data-add="${w}">${WIDGETS[w].icon}${esc(WIDGETS[w].title)}</button>`).join('')}` : ''}
      <div class="menu-sep"></div>
      <button data-act="layouts">${I('<rect x="3.5" y="4" width="7" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="4" width="7" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="13" width="7" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>')}Layouts &amp; text size…</button>`;
    const r = btn.getBoundingClientRect();
    this.menu.hidden = false;
    this.menu.style.top = `${r.bottom + 6}px`;
    this.menu.style.left = `${Math.max(8, Math.min(window.innerWidth - this.menu.offsetWidth - 8, r.right - this.menu.offsetWidth))}px`;
    this.menu.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.menu.hidden = true;
      if (b.dataset.add) { g.tabs.push(b.dataset.add); g.active = b.dataset.add; this.state.preset = null; this.save(); this.render(); this.store.dirty?.(); return; }
      const act = b.dataset.act;
      if (act === 'right' || act === 'below') {
        if (g.tabs.length === 1 && act === 'below') return;
        this.move(id, col, g, act);
      } else if (act === 'close') this.show(id, false);
      else if (act === 'layouts') this.store.openLayoutPop?.();
    };
  }

  // ---------------------------------------------------------------- resizing
  #colResizer(ci) {
    const h = div('col-resizer');
    h.addEventListener('pointerdown', (e) => {
      const cols = [...this.root.querySelectorAll(':scope > .col')];
      const a = cols[ci - 1], b = cols[ci];
      const ca = this.state.cols[ci - 1], cb = this.state.cols[ci];
      const startX = e.clientX, wa = a.getBoundingClientRect().width, wb = b.getBoundingClientRect().width;
      const total = (ca.w ?? 1) + (cb.w ?? 1);
      h.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing-x');
      const move = (ev) => {
        const dx = Math.max(-(wa - 260), Math.min(wb - 260, ev.clientX - startX));
        ca.w = (total * (wa + dx)) / (wa + wb);
        cb.w = total - ca.w;
        a.style.flex = `${ca.w} 1 0`; b.style.flex = `${cb.w} 1 0`;
        this.store.dirty?.();
      };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); document.body.classList.remove('resizing-x'); this.state.preset = null; this.save(); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    h.addEventListener('dblclick', () => { const t = (this.state.cols[ci - 1].w ?? 1) + (this.state.cols[ci].w ?? 1); this.state.cols[ci - 1].w = this.state.cols[ci].w = t / 2; this.save(); this.render(); });
    return h;
  }

  #rowResizer(ci, gi, colEl) {
    const h = div('row-resizer');
    h.addEventListener('pointerdown', (e) => {
      const groups = [...colEl.querySelectorAll(':scope > .group')];
      const a = groups[gi - 1], b = groups[gi];
      const ga = this.state.cols[ci].groups[gi - 1], gb = this.state.cols[ci].groups[gi];
      const startY = e.clientY, ha = a.getBoundingClientRect().height, hb = b.getBoundingClientRect().height;
      const total = (ga.h ?? 1) + (gb.h ?? 1);
      h.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing-y');
      const move = (ev) => {
        const dy = Math.max(-(ha - 120), Math.min(hb - 120, ev.clientY - startY));
        ga.h = (total * (ha + dy)) / (ha + hb);
        gb.h = total - ga.h;
        a.style.flex = `${ga.h} 1 0`; b.style.flex = `${gb.h} 1 0`;
        this.store.dirty?.();
      };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); document.body.classList.remove('resizing-y'); this.state.preset = null; this.save(); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    return h;
  }
}
