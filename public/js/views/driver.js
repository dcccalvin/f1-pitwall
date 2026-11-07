// Driver focus: everything about one driver in one place. Click a driver anywhere
// (timing tower, map, battles, radio, moments, race control) to follow them here.
import { esc, teamColor, sessionKind, segClass, driverOrder, currentStint, stintList, compoundLetter, parseLap, fmtLap, sessionLocalTime, trackState } from '../format.js';
import { gapSeconds } from '../history.js';
import { penalties, penaltyBadge } from '../penalties.js';
import { avatar, teamLogo, carImage, img } from '../media.js';

const COMP_COLOR = { SOFT: 'var(--tyre-soft)', MEDIUM: 'var(--tyre-medium)', HARD: 'var(--tyre-hard)', INTERMEDIATE: 'var(--tyre-inter)', WET: 'var(--tyre-wet)' };
const list = (raw) => (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean);
const signed = (v) => (v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(3)}`);

export class DriverPanel {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('driver');
    this.key = '';
    this.root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-pick],[data-act],[data-radio],[data-num]');
      if (!t) return;
      if (t.dataset.pick) store.select(t.dataset.pick);
      else if (t.dataset.radio) store.playRadio?.(t.dataset.radio);
      else if (t.dataset.act === 'follow') { store.map?.setFollow(!store.map.follow); this.key = ''; store.dirty(); }
      else if (t.dataset.act === 'alerts') { store.setAlerts(!store.alerts); this.key = ''; store.dirty(); }
      else if (t.dataset.act === 'clear') store.select(null);
      else if (t.dataset.num) store.select(t.dataset.num);
    });
  }

  update() {
    const s = this.store.state;
    const num = this.store.selected;
    const lines = s.TimingData?.Lines || {};
    if (!num || !lines[num]) return this.#empty(s);

    const kind = sessionKind(s);
    const order = driverOrder(s);
    const i = order.indexOf(num);
    const l = lines[num];
    const d = s.DriverList?.[num] || {};
    const dl = s.DriverList || {};
    const stats = s.TimingStats?.Lines?.[num] || {};
    const st = currentStint(s, num);
    const now = this.store.playNow();
    const laps = this.store.history?.of(num, now) || [];
    const part = Number(s.TimingData?.SessionPart) || 1;

    // neighbours
    const ahead = order[i - 1], behind = order[i + 1];
    let gap, intAhead, intBehind;
    if (kind === 'race') {
      gap = l.GapToLeader; intAhead = l.IntervalToPositionAhead?.Value; intBehind = lines[behind]?.IntervalToPositionAhead?.Value;
    } else {
      const q = (x) => (kind === 'quali' ? list(x?.Stats)[part - 1] : null);
      gap = q(l)?.TimeDiffToFastest ?? l.TimeDiffToFastest; intAhead = q(l)?.TimeDiffToPositionAhead ?? l.TimeDiffToPositionAhead;
      intBehind = q(lines[behind])?.TimeDiffToPositionAhead ?? lines[behind]?.TimeDiffToPositionAhead;
    }

    // laps
    const bestLap = kind === 'quali' ? (list(l.BestLapTimes)[part - 1]?.Value || l.BestLapTime?.Value) : l.BestLapTime?.Value;
    const bestSecs = list(stats.BestSectors).map((x) => parseLap(x?.Value));
    const ideal = bestSecs.length === 3 && bestSecs.every((x) => x) ? bestSecs.reduce((a, b) => a + b, 0) : null;
    const bestS = parseLap(bestLap);

    // race control mentions of this car
    // "CAR 63 (RUS) ..." or "CARS 6 (HAD) AND 30 (LAW) ..."
    const mention = new RegExp(`\\b${num} \\([A-Z]{3}\\)`);
    const rcm = list(s.RaceControlMessages?.Messages).filter((m) => mention.test(m.Message || ''));
    const seenMsg = new Set();
    const mentions = rcm.filter((m) => { const k = m.Utc + m.Message; if (seenMsg.has(k)) return false; seenMsg.add(k); return true; });
    const strikes = mentions.filter((m) => /DELETED/.test(m.Message) && /TRACK LIMITS/.test(m.Message)).length;
    const bw = mentions.some((m) => /BLACK AND WHITE/.test(m.Message));

    // team radio from this driver
    const clips = list(s.TeamRadio?.Captures).filter((c) => String(c.RacingNumber) === String(num)).slice(-6).reverse();

    const pens = penalties(s, this.store.history);
    const grid = Number(s.TimingAppData?.Lines?.[num]?.GridPos);
    const gained = kind === 'race' && grid ? grid - Number(l.Position) : null;
    const status = l.Retired ? 'Retired' : l.Stopped ? 'Stopped' : l.KnockedOut ? `Out in Q${part - 1 || 1}` : l.InPit ? 'In the pits' : l.PitOut ? 'Out lap' : '';

    const model = {
      num, pos: l.Position, tla: d.Tla, name: d.FullName || d.BroadcastName, team: d.TeamName, color: teamColor(d), status,
      gap, intAhead, intBehind, ahead: ahead && dl[ahead]?.Tla, behind: behind && dl[behind]?.Tla, aheadNum: ahead, behindNum: behind,
      last: l.LastLapTime?.Value, lastCls: l.LastLapTime?.OverallFastest ? 'purple' : l.LastLapTime?.PersonalFastest ? 'green' : '',
      best: bestLap, bestRank: stats.PersonalBestLapTime?.Position, ideal: ideal && fmtLap(ideal), idealGain: ideal && bestS ? bestS - ideal : null,
      comp: st?.Compound, age: st?.TotalLaps, fresh: st?.New === 'true' || st?.New === true, pits: l.NumberOfPitStops, lapsDone: l.NumberOfLaps,
      trap: l.Speeds?.ST?.Value, trapBest: stats.BestSpeeds?.ST?.Value, trapRank: stats.BestSpeeds?.ST?.Position, gained, strikes, bw,
      sectors: list(l.Sectors).map((x, k) => ({ v: x?.Value, cls: x?.OverallFastest ? 'purple' : x?.PersonalFastest ? 'green' : '', segs: list(x?.Segments).map((g) => segClass(g?.Status)), pb: list(stats.BestSectors)[k]?.Value, pbRank: list(stats.BestSectors)[k]?.Position })),
      laps: laps.map((x) => [x.lap, x.time, x.pb, x.purple, x.pit, x.comp]),
      stints: stintList(s, num).map((x) => [x.Compound, Math.max(0, (Number(x.TotalLaps) || 0) - (Number(x.StartLaps) || 0)), x.New === 'true' || x.New === true]),
      mentions: mentions.slice(-6).reverse().map((m) => [m.Utc, m.Message]),
      clips: clips.map((c) => [c.Path, c.Utc]),
      context: this.#context(s, kind, num, l, part, order, bestLap, kind === 'race' ? pens : {}),
      penalty: penaltyBadge(pens[num]),
      penaltyItems: (pens[num]?.items || []).map((x) => [x.kind, x.secs, x.served || '']),
      pid: d.PublicIdRight || d.HeadshotUrl || '', theme: document.body.dataset.theme,
      follow: !!this.store.map?.follow, alerts: !!this.store.alerts,
    };
    const key = JSON.stringify(model);
    if (key === this.key) return;
    this.key = key;
    this.root.innerHTML = this.#render(model, s, kind);
  }

  /** Session-specific insight: qualifying cut-off margin, or race pit-stop rejoin estimate. */
  #context(s, kind, num, l, part, order, bestLap, pens = {}) {
    const lines = s.TimingData?.Lines || {};
    const dl = s.DriverList || {};
    if (kind === 'quali') {
      const cut = parseLap(s.TimingData?.CutOffTime);
      const mine = parseLap(bestLap);
      if (l.KnockedOut) return { kind: 'quali', text: 'Knocked out', tone: 'bad' };
      if (part >= 3) return { kind: 'quali', text: `Q3: fighting for pole · ${mine ? `best ${fmtLap(mine)}` : 'no time yet'}` };
      if (!cut) return null;
      const n = list(s.TimingData?.NoEntries)[part] || (part === 1 ? 16 : 10);
      if (!mine) return { kind: 'quali', text: `No time set yet · cut-off is ${fmtLap(cut)} (P${n})`, tone: 'warn' };
      const d = mine - cut;
      return d <= 0
        ? { kind: 'quali', text: `Safe by ${Math.abs(d).toFixed(3)} s · cut-off ${fmtLap(cut)} (P${n})`, tone: 'good' }
        : { kind: 'quali', text: `In the drop zone · needs ${d.toFixed(3)} s to reach the cut-off ${fmtLap(cut)} (P${n})`, tone: 'bad' };
    }
    if (kind === 'race') {
      const pl = this.store.circuit?.pitLoss;
      if (!pl || l.InPit || l.Retired) return null;
      const ts = trackState(s).key;
      const loss = Number(ts === 'sc' ? pl.sc : ts.startsWith('vsc') ? pl.vsc : pl.normal);
      const myGap = gapSeconds(l.GapToLeader);
      if (myGap == null || !isFinite(loss)) return null;
      // An unserved time penalty is served stationary at the next stop: it adds to the loss.
      const owed = pens[num]?.pending || 0;
      const target = myGap + loss + owed;
      let pos = 1, front = null, back = null;
      for (const n of order) {
        if (n === num) continue;
        const o = lines[n];
        if (!o || o.Retired || o.InPit) continue;
        const g = gapSeconds(o.GapToLeader);
        if (g == null) continue;
        if (g < target) { pos++; if (!front || g > front.g) front = { n, g }; } else if (!back || g < back.g) back = { n, g };
      }
      const parts = [`Pit now → rejoin around P${pos}`];
      if (front) parts.push(`${(target - front.g).toFixed(1)} s behind ${dl[front.n]?.Tla || front.n}`);
      if (back) parts.push(`${(back.g - target).toFixed(1)} s ahead of ${dl[back.n]?.Tla || back.n}`);
      // Where they'd finish if the race ended now, with everyone's unserved time penalties added.
      let finish = '';
      if (Object.values(pens).some((p) => p.pending)) {
        const eff = myGap + owed;
        let p2 = 1;
        for (const n of order) {
          if (n === num) continue;
          const o = lines[n];
          if (!o || o.Retired) continue;
          const g = gapSeconds(o.GapToLeader);
          if (g != null && g + (pens[n]?.pending || 0) < eff) p2++;
        }
        finish = ` · if it ended now with penalties applied: P${p2}`;
      }
      const under = ts === 'sc' ? ' under the safety car' : ts.startsWith('vsc') ? ' under the VSC' : '';
      const note = `Pit loss ${loss.toFixed(1)} s${under}${owed ? ` + ${owed} s penalty served at the stop` : ''} · estimate${finish}`;
      return { kind: 'race', text: parts.join(' · '), note };
    }
    return null;
  }

  #render(m, s, kind) {
    const off = s.SessionInfo?.GmtOffset;
    const cell = (k, v, cls = '', sub = '') => `<div class="dv-cell"><div class="dv-k">${k}</div><div class="dv-v ${cls}">${v ?? '–'}</div>${sub ? `<div class="dv-sub">${sub}</div>` : ''}</div>`;
    const tyre = m.comp ? `<span class="tyre sm ${esc(m.comp)}">${compoundLetter(m.comp)}</span> ${esc(m.age ?? 0)} laps${m.fresh ? '' : ' · used'}` : '–';
    const lapsTimed = m.laps.filter((x) => x[1]);
    return `
      <div class="dv-head" style="--tc:${m.color}">
        ${img(carImage(s.DriverList?.[m.num]), 'dv-car')}
        <div class="dv-pos">${esc(m.pos || '–')}</div>
        ${avatar(s.DriverList?.[m.num], 'av av-lg')}
        <div class="dv-who"><b>${esc(m.tla || m.num)}${m.penalty ? ` <em class="d-pen">${esc(m.penalty)}</em>` : ''}</b><span>${esc(m.name || '')} · #${esc(m.num)} · ${img(teamLogo(s.DriverList?.[m.num]), 'dv-logo')}${esc(m.team || '')}</span></div>
        ${m.status ? `<span class="dv-status">${esc(m.status)}</span>` : ''}
        <div class="dv-actions">
          <button class="mini-btn${m.follow ? ' on' : ''}" data-act="follow" title="Zoom the track map onto this driver">Follow on map</button>
          <button class="mini-btn${m.alerts ? ' on' : ''}" data-act="alerts" title="Pop-ups for this driver's pit stops, overtakes, fastest laps, penalties and radio">Alerts</button>
          <button class="icon-btn" data-act="clear" title="Stop following" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
        </div>
      </div>
      ${m.context ? `<div class="dv-context ${m.context.tone || ''}"><b>${esc(m.context.text)}</b>${m.context.note ? `<span>${esc(m.context.note)}</span>` : ''}</div>` : ''}
      <div class="dv-grid">
        ${cell(kind === 'race' ? 'Gap to leader' : 'Gap to fastest', esc(m.gap || (m.pos === '1' ? 'Leader' : '–')))}
        ${cell('Car ahead', m.ahead ? `<button class="dv-link" data-num="${esc(m.aheadNum)}">${esc(m.ahead)}</button> ${esc(m.intAhead || '')}` : '–')}
        ${cell('Car behind', m.behind ? `<button class="dv-link" data-num="${esc(m.behindNum)}">${esc(m.behind)}</button> ${esc(m.intBehind || '')}` : '–')}
        ${cell('Last lap', esc(m.last || '–'), m.lastCls)}
        ${cell('Best lap', esc(m.best || '–'), '', m.bestRank ? `P${esc(m.bestRank)} on best laps` : '')}
        ${cell('Ideal lap', esc(m.ideal || '–'), '', m.idealGain > 0.001 ? `${m.idealGain.toFixed(3)} s left on the table` : m.ideal ? 'Best lap = best sectors' : 'Sum of best sectors')}
        ${cell('Tyre', tyre)}
        ${cell(kind === 'race' ? 'Pit stops' : 'Laps', esc(kind === 'race' ? m.pits ?? 0 : m.lapsDone ?? 0), '', kind === 'race' ? `${esc(m.lapsDone ?? 0)} laps done` : '')}
        ${cell('Speed trap', m.trapBest ? `${esc(m.trapBest)} km/h` : '–', '', m.trapRank ? `P${esc(m.trapRank)} fastest · last ${esc(m.trap || '–')}` : '')}
        ${kind === 'race' ? cell('Since start', m.gained == null ? '–' : m.gained > 0 ? `▲ ${m.gained}` : m.gained < 0 ? `▼ ${-m.gained}` : 'No change', m.gained > 0 ? 'up' : m.gained < 0 ? 'down' : '') : ''}
        ${cell('Track limits', m.strikes ? `${m.strikes} strike${m.strikes > 1 ? 's' : ''}` : 'Clean', m.strikes >= 3 ? 'bad' : '', m.bw ? 'Black-and-white flag shown' : m.strikes ? 'Lap times deleted' : '')}
        ${m.penaltyItems.length ? cell('Penalties', m.penalty ? `${esc(m.penalty)} owed` : 'All served', m.penalty ? 'bad' : '', m.penaltyItems.map(([k, sec, served]) => `${k === 'time' ? `${sec} s time` : k === 'dt' ? 'Drive-through' : `${sec} s stop/go`}${served === 'withdrawn' ? ' (withdrawn)' : served ? ' (served)' : ''}`).join(' · ')) : ''}
      </div>
      <div class="dv-sec"><div class="dv-h">Sectors</div><div class="dv-sectors">
        ${[0, 1, 2].map((k) => { const x = m.sectors[k] || { segs: [] }; return `<div><div class="dv-k">S${k + 1}</div><div class="segs">${x.segs.map((c) => `<i class="${c}"></i>`).join('')}</div><div class="dv-v ${x.cls}">${esc(x.v || '–')}</div><div class="dv-sub">best ${esc(x.pb || '–')}${x.pbRank ? ` · P${esc(x.pbRank)}` : ''}</div></div>`; }).join('')}
      </div></div>
      <div class="dv-sec"><div class="dv-h">Lap times <span>${lapsTimed.length ? `${lapsTimed.length} timed laps this session` : 'appear as laps are completed'}</span></div>${lapChart(m.laps)}</div>
      ${m.stints.length ? `<div class="dv-sec"><div class="dv-h">Tyres this session</div><div class="dv-stints">${m.stints.map(([c, n, fresh]) => `<span class="dv-stint" style="--c:${COMP_COLOR[c] || 'var(--tyre-unknown)'};flex:${Math.max(1, n)}" title="${esc(c)} · ${n} laps${fresh ? '' : ' (used set)'}">${compoundLetter(c)} ${n}</span>`).join('')}</div></div>` : ''}
      ${m.clips.length ? `<div class="dv-sec"><div class="dv-h">Team radio</div>${m.clips.map(([p, u]) => `<button class="dv-clip" data-radio="${esc(p)}"><svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>${esc(sessionLocalTime(u, off))}</button>`).join('')}</div>` : ''}
      ${m.mentions.length ? `<div class="dv-sec"><div class="dv-h">Race control</div>${m.mentions.map(([u, t]) => `<div class="dv-rc"><span>${esc(sessionLocalTime(u, off).slice(0, 5))}</span>${esc(t)}</div>`).join('')}</div>` : ''}`;
  }

  #empty(s) {
    const order = driverOrder(s);
    const dl = s.DriverList || {};
    const key = `empty|${order.join()}`;
    if (key === this.key) return;
    this.key = key;
    this.root.innerHTML = order.length
      ? `<div class="dv-empty"><b>Pick a driver to follow</b><span>Or click one anywhere: timing tower, track map, battles, radio or moments.</span>
          <div class="dv-pick">${order.map((n) => `<button data-pick="${esc(n)}" style="--tc:${teamColor(dl[n])}">${avatar(dl[n], 'av')}<span>${esc(dl[n]?.Tla || n)}</span></button>`).join('')}</div></div>`
      : '<div class="feed-empty">Waiting for a session…</div>';
  }
}

/** Little bar chart of lap times: taller = faster, coloured by tyre, pit laps faded. */
function lapChart(laps) {
  const timed = laps.filter((x) => x[1]);
  if (!timed.length) return '<div class="dv-chart-empty">No lap times yet.</div>';
  const clean = timed.filter((x) => !x[4]).map((x) => x[1]).sort((a, b) => a - b);
  const best = clean[0] ?? Math.min(...timed.map((x) => x[1]));
  const top = best * 1.08;
  const n = laps.length;
  const W = Math.max(n * 12, 120), H = 70;
  const bars = laps.map(([lap, t, pb, purple, pit, comp], i) => {
    if (!t) return '';
    const h = Math.max(3, ((top - Math.min(t, top)) / (top - best * 0.995)) * H);
    const fill = purple ? 'var(--purple)' : COMP_COLOR[comp] || 'var(--text-3)';
    return `<rect x="${i * 12 + 1}" y="${H - h}" width="10" height="${h}" fill="${fill}" opacity="${pit || t > top ? 0.3 : 0.85}"${pb && !purple ? ' stroke="var(--green)" stroke-width="1.5"' : ''}><title>Lap ${lap}: ${fmtLap(t)}${pit ? ' (pit)' : ''}${purple ? ' · fastest overall' : pb ? ' · personal best' : ''}</title></rect>`;
  }).join('');
  return `<div class="dv-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>
    <div class="dv-chart-axis"><span>Lap ${laps[0]?.[0] ?? ''}</span><span>best ${fmtLap(best)} · faster laps are taller</span><span>Lap ${laps.at(-1)?.[0] ?? ''}</span></div></div>`;
}
