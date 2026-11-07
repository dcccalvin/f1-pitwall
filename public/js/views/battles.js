// Battles: cars within 1.5 s of the car ahead, with closing/opening trend and a
// sparkline of the interval. Under 1.0 s is "attack range" (2026 overtake mode).
import { esc, teamColor, driverOrder, sessionKind, currentStint, compoundLetter, parseLap } from '../format.js';

const RANGE = 1.5;

export class Battles {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('battles');
    this.hist = new Map(); // "ahead>behind" -> [{t, iv, lap}]
    this.key = '';
    this.shown = new Map(); // pair -> interval last drawn (to animate new/changed)
  }

  reset() { this.hist.clear(); }

  onMessage(t, topic, data, state) {
    if (topic !== 'TimingData' || !data?.Lines || sessionKind(state) !== 'race') return;
    const lines = state.TimingData?.Lines || {};
    const byPos = new Map(Object.entries(lines).map(([n, l]) => [Number(l?.Position), n]));
    for (const [num, l] of Object.entries(data.Lines)) {
      const v = l?.IntervalToPositionAhead?.Value;
      if (v == null) continue;
      const iv = parseLap(String(v).replace('+', ''));
      if (iv == null) continue;
      const ahead = byPos.get(Number(lines[num]?.Position) - 1);
      if (!ahead) continue;
      const k = `${ahead}>${num}`;
      let arr = this.hist.get(k);
      if (!arr) { arr = []; this.hist.set(k, arr); }
      arr.push({ t, iv, lap: Number(state.LapCount?.CurrentLap) || 0 });
      if (arr.length > 30) arr.shift();
    }
  }

  update() {
    const s = this.store.state;
    if (sessionKind(s) !== 'race') {
      if (this.key !== 'none') { this.key = 'none'; this.root.innerHTML = '<div class="feed-empty"><b>Battles appear during races.</b><br>Cars within 1.5 seconds of each other show up here, closest fights first.</div>'; }
      return;
    }
    const order = driverOrder(s);
    const lines = s.TimingData?.Lines || {};
    const dl = s.DriverList || {};
    const battles = [];
    for (let i = 1; i < order.length; i++) {
      const b = order[i], a = order[i - 1];
      const lb = lines[b], la = lines[a];
      if (!lb || !la || lb.InPit || la.InPit || lb.Retired || la.Retired || lb.Stopped) continue;
      const iv = parseLap(String(lb.IntervalToPositionAhead?.Value ?? '').replace('+', ''));
      if (iv == null || iv > RANGE) continue;
      const h = this.hist.get(`${a}>${b}`) || [];
      const recent = h.filter((x) => x.iv <= RANGE + 0.5);
      const prev = h.length >= 3 ? h[h.length - 3].iv : null;
      const trend = prev == null ? 0 : iv - prev;
      // laps fought: from the earliest consecutive close sample
      let since = null;
      for (let k = h.length - 1; k >= 0 && h[k].iv <= RANGE + 0.3; k--) since = h[k].lap;
      battles.push({ a, b, iv, trend, pos: i + 1, spark: recent.slice(-16).map((x) => x.iv), laps: since ? Math.max(0, (Number(s.LapCount?.CurrentLap) || since) - since) : 0 });
    }
    const key = JSON.stringify(battles.map((x) => [x.a, x.b, x.iv, Math.sign(Math.round(x.trend * 20)), x.laps, x.spark.length]));
    if (key === this.key) return;
    this.key = key;
    if (!battles.length) { this.root.innerHTML = '<div class="feed-empty"><b>No close fights right now.</b><br>Cars within 1.5 s of the car ahead appear here.</div>'; return; }

    const car = (num, cls) => {
      const d = dl[num] || {};
      const st = currentStint(s, num);
      return `<div class="b-car ${cls}" style="--tc:${teamColor(d)}" data-num="${esc(num)}">
        <i class="b-bar"></i><div class="b-who"><b>${esc(d.Tla || num)}</b><span>${esc(d.LastName || '')}</span></div>
        ${st ? `<span class="tyre sm ${esc(st.Compound)}">${compoundLetter(st.Compound)}</span>` : ''}
      </div>`;
    };
    const before = this.shown;
    this.shown = new Map(battles.map((x) => [`${x.a}>${x.b}`, x.iv]));
    this.root.innerHTML = battles.map((x) => {
      const pair = `${x.a}>${x.b}`;
      const isNew = before.size > 0 && !before.has(pair);
      const changed = before.has(pair) && before.get(pair) !== x.iv;
      const attack = x.iv < 1.0;
      const tr = x.trend < -0.04 ? ['closing', `▼ ${Math.abs(x.trend).toFixed(2)}s`] : x.trend > 0.04 ? ['opening', `▲ ${x.trend.toFixed(2)}s`] : ['steady', 'steady'];
      return `<div class="battle${attack ? ' attack' : ''}${isNew ? ' new' : ''}">
        <div class="b-head"><span class="b-pos">P${x.pos - 1} · P${x.pos}</span>${attack ? '<span class="b-tag">Within 1 s</span>' : ''}${x.laps ? `<span class="b-laps">${x.laps} lap${x.laps === 1 ? '' : 's'}</span>` : ''}</div>
        <div class="b-row">
          ${car(x.a, 'ahead')}
          <div class="b-gap"><span class="b-iv${changed ? ' changed' : ''}">${x.iv.toFixed(3)}</span><span class="b-trend ${tr[0]}">${tr[1]}</span></div>
          ${car(x.b, 'behind')}
        </div>
        ${x.spark.length > 2 ? spark(x.spark) : ''}
      </div>`;
    }).join('');
  }
}

function spark(vals) {
  const w = 100, h = 22, max = Math.max(RANGE, ...vals), min = 0;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - min) / (max - min)) * h).toFixed(1)}`).join(' ');
  const oneSec = h - (1 / max) * h;
  return `<svg class="b-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" x2="${w}" y1="${oneSec}" y2="${oneSec}" class="b-line1"/><polyline points="${pts}"/></svg>`;
}
