// Demo mode: simulates a race at Interlagos and emits messages in exactly the same
// format as F1's live timing feed, so the whole dashboard can be tried (and
// developed) when no session is live. With `f1tv: true` it also emits the
// F1-TV-only topics (car telemetry + GPS positions) to preview what they unlock.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(here, 'demo', f), 'utf8'));

const SEGMENTS = [7, 8, 7];
const SECTOR_BOUNDS = [0, 0.258, 0.775, 1];
const TOTAL_LAPS = 40;
const BASE_LAP = 72.6;
const LAP_LENGTH_M = 4309;
const TICK_MS = 100;

const COMPOUND = {
  SOFT: { offset: -0.7, deg: 0.075, cliff: 16 },
  MEDIUM: { offset: -0.25, deg: 0.045, cliff: 26 },
  HARD: { offset: 0, deg: 0.03, cliff: 40 },
};

const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function fmtLap(s) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
}
const fmtSec = (s) => (s >= 60 ? fmtLap(s) : s.toFixed(3));
const fmtGap = (s) => `+${s.toFixed(3)}`;
const utc = (ms = Date.now()) => new Date(ms).toISOString();

// Every timing loop in one lap: segment ends, flagged when they also end a sector/lap.
const LOOPS = (() => {
  const out = [];
  SEGMENTS.forEach((n, s) => {
    for (let j = 0; j < n; j++) {
      const frac = SECTOR_BOUNDS[s] + ((SECTOR_BOUNDS[s + 1] - SECTOR_BOUNDS[s]) * (j + 1)) / n;
      out.push({ frac: j === n - 1 && s === 2 ? 1 : frac, sector: s, seg: j, sectorEnd: j === n - 1, lapEnd: s === 2 && j === n - 1 });
    }
  });
  return out;
})();

// Speed/position profile from a real reference lap of the circuit outline.
function buildProfile(track) {
  const { x, y, trackPositionTime: tt } = track;
  const n = x.length;
  const lapT = tt[n - 1];
  let len = 0;
  const d = [0];
  for (let i = 1; i < n; i++) { len += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]); d.push(len); }
  const scale = LAP_LENGTH_M / len; // outline units -> metres
  const raw = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    const dt = tt[b] - tt[a];
    raw.push(dt > 0 ? ((d[b] - d[a]) * scale / dt) * 3.6 : 0);
  }
  const speed = raw.map((_, i) => { // smooth
    let s = 0, c = 0;
    for (let k = -3; k <= 3; k++) { const v = raw[i + k]; if (v) { s += v; c++; } }
    return c ? s / c : 0;
  });
  return { x, y, tt, lapT, speed };
}

function sampleProfile(p, frac) {
  const t = Math.max(0, Math.min(1, frac)) * p.lapT;
  let lo = 0, hi = p.tt.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.tt[mid] <= t) lo = mid; else hi = mid; }
  const span = p.tt[hi] - p.tt[lo] || 1;
  const k = (t - p.tt[lo]) / span;
  const lerp = (arr) => arr[lo] + (arr[hi] - arr[lo]) * k;
  const next = Math.min(p.speed.length - 1, hi + 2);
  return { x: lerp(p.x), y: lerp(p.y), speed: lerp(p.speed), accel: p.speed[next] - p.speed[lo] };
}

function gearFor(speed) {
  const limits = [0, 85, 125, 160, 200, 240, 278, 305];
  let g = 1;
  for (let i = 0; i < limits.length; i++) if (speed >= limits[i]) g = i + 1;
  const lo = limits[g - 1], hi = limits[g] ?? 345;
  return { gear: Math.min(8, g), rpm: Math.round(10400 + ((speed - lo) / (hi - lo)) * 1800 + rand(-120, 120)) };
}

export class Simulator extends EventEmitter {
  constructor({ f1tv = false, speed = 1 } = {}) {
    super();
    this.f1tv = f1tv;
    this.speed = speed;
    this.drivers = load('drivers.json');
    this.track = load('track.json');
    this.radio = load('radio.json');
    this.profile = buildProfile(this.track);
  }

  start() {
    this.#reset();
    this.emit('status', { state: 'demo', detail: this.f1tv ? 'Demo · F1 TV preview' : 'Demo · free data', authenticated: this.f1tv });
    this.emit('init', this.#initialState());
    this.timer = setInterval(() => this.#tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.restartTimer);
  }

  #send(topic, data) {
    this.emit('feed', topic, data, utc());
  }

  #line(num, patch) {
    this.#send('TimingData', { Lines: { [num]: patch } });
  }

  // ---------------------------------------------------------------- setup
  #reset() {
    this.simT = 0;
    // Race start: a short countdown to the scheduled start, the formation lap (the
    // free feed says nothing during it), then lights out = SessionStatus "Started".
    this.preT = 0;
    this.formationAt = 20;
    this.lightsAt = 50;
    this.started = false;
    this.wallStart = Date.now();
    this.finished = false;
    this.track_status = '1';
    this.sc = null; // {kind:'SC'|'VSC', untilLap}
    this.events = this.#plannedEvents();
    this.crossings = new Map(); // `${lap}:${point}` -> Map(num -> time)
    this.bestSeg = LOOPS.map(() => Infinity);
    this.bestSector = [Infinity, Infinity, Infinity];
    this.bestLap = Infinity;
    this.rcm = 0;
    this.radioIdx = 0;
    this.nextRadioAt = 25;
    this.nextWeatherAt = 60;
    this.weather = { AirTemp: 27.4, TrackTemp: 44.8, Humidity: 58, Pressure: 922.6, WindSpeed: 2.1, WindDirection: 140, Rainfall: 0 };
    this.lapCount = 1;
    this.telemetryBuf = [];
    this.positionBuf = [];
    this.lastSampleT = 0;
    this.lastFlushT = 0;

    const grid = this.drivers;
    this.cars = grid.map((d, i) => {
      const startCompound = i < 10 ? (Math.random() < 0.7 ? 'MEDIUM' : 'SOFT') : (Math.random() < 0.6 ? 'HARD' : 'MEDIUM');
      const stops = this.#planStops(startCompound);
      return {
        num: d.RacingNumber,
        tla: d.Tla,
        grid: i + 1,
        pace: BASE_LAP + i * 0.055 + rand(-0.12, 0.12),
        prog: -0.0025 * i - 0.004, // staggered behind the line
        lapNoise: 0,
        laps: 0,
        compound: startCompound,
        tyreAge: 0,
        stintIdx: 0,
        stops,
        stopsDone: 0,
        pitTimer: 0,
        pitOut: false,
        inPit: false,
        retired: false,
        finished: false,
        lastLoopT: 0,
        lastSectorT: 0,
        lastLapT: 0,
        segBest: LOOPS.map(() => Infinity),
        sectorBest: [Infinity, Infinity, Infinity],
        lapBest: Infinity,
        lapStartT: 0,
        sectors: [null, null, null],
        position: i + 1,
        prevInterval: null,
        topSpeed: 300 + rand(-8, 10),
      };
    });
  }

  #planStops(start) {
    // One or two stops, sensible compounds for the remaining distance.
    const two = Math.random() < 0.35;
    if (two) return [{ lap: Math.round(rand(9, 14)), to: 'MEDIUM' }, { lap: Math.round(rand(24, 29)), to: pick(['SOFT', 'MEDIUM']) }];
    if (start === 'HARD') return [{ lap: Math.round(rand(20, 27)), to: pick(['MEDIUM', 'SOFT']) }];
    return [{ lap: Math.round(rand(13, 20)), to: 'HARD' }];
  }

  #plannedEvents() {
    return {
      yellowLap: 3,
      vscLap: Math.round(rand(6, 8)),
      scLap: Math.round(rand(17, 21)),
      penaltyLap: 11,
      trackLimitsLaps: [5, 9, 14, 23, 31],
      investigateLap: 8,
    };
  }

  #initialState() {
    const lines = {}, app = {}, stats = {};
    const segs = (n) => Array.from({ length: n }, () => ({ Status: 0 }));
    this.cars.forEach((c, i) => {
      lines[c.num] = {
        RacingNumber: c.num, Line: i + 1, Position: String(i + 1), ShowPosition: true,
        GapToLeader: '', IntervalToPositionAhead: { Value: '', Catching: false },
        Retired: false, InPit: false, PitOut: false, Stopped: false, Status: 0,
        NumberOfLaps: 0, NumberOfPitStops: 0,
        Sectors: SEGMENTS.map((n) => ({ Stopped: false, Value: '', Status: 0, OverallFastest: false, PersonalFastest: false, Segments: segs(n) })),
        Speeds: Object.fromEntries(['I1', 'I2', 'FL', 'ST'].map((k) => [k, { Value: '', Status: 0, OverallFastest: false, PersonalFastest: false }])),
        BestLapTime: { Value: '' }, LastLapTime: { Value: '', Status: 0, OverallFastest: false, PersonalFastest: false },
      };
      app[c.num] = { RacingNumber: c.num, Line: i + 1, GridPos: String(i + 1), Stints: [{ LapFlags: 0, Compound: c.compound, New: 'true', TyresNotChanged: '0', TotalLaps: 0, StartLaps: 0 }] };
      stats[c.num] = { Line: i + 1, RacingNumber: c.num, PersonalBestLapTime: { Value: '' }, BestSectors: [{ Value: '' }, { Value: '' }, { Value: '' }], BestSpeeds: {} };
    });
    const driverList = {};
    this.drivers.forEach((d, i) => { driverList[d.RacingNumber] = { ...d, Line: i + 1 }; });
    const now = Date.now();
    const state = {
      SessionInfo: {
        Meeting: { Key: 9999, Name: 'São Paulo Grand Prix', OfficialName: 'Demo race', Location: 'São Paulo', Country: { Code: 'BRA', Name: 'Brazil' }, Circuit: { Key: 14, ShortName: 'Interlagos' } },
        Key: 99999, Type: 'Race', Name: 'Race', StartDate: utc(now + (this.formationAt * 1000) / this.speed - 3 * 3600e3).slice(0, 19), GmtOffset: '-03:00:00',
        Path: this.radio.sessionPath, Demo: true,
      },
      SessionStatus: { Status: 'Inactive' },
      TrackStatus: { Status: '1', Message: 'AllClear' },
      LapCount: { CurrentLap: 1, TotalLaps: TOTAL_LAPS },
      ExtrapolatedClock: { Utc: utc(now), Remaining: '02:00:00', Extrapolating: false },
      WeatherData: this.#weatherMsg(),
      DriverList: driverList,
      TimingData: { Lines: lines, Withheld: false },
      TimingAppData: { Lines: app },
      TimingStats: { Lines: stats, Withheld: false, SessionType: 'Race' },
      RaceControlMessages: { Messages: [] },
      TeamRadio: { Captures: [] },
      PitLaneTimeCollection: { PitTimes: {} },
      SessionData: { Series: [], StatusSeries: [] },
    };
    if (this.f1tv) {
      state.CarData = { Entries: [] };
      state.Position = { Position: [] };
    }
    return state;
  }

  #weatherMsg() {
    const w = this.weather;
    return {
      AirTemp: w.AirTemp.toFixed(1), TrackTemp: w.TrackTemp.toFixed(1), Humidity: w.Humidity.toFixed(1),
      Pressure: w.Pressure.toFixed(1), WindSpeed: w.WindSpeed.toFixed(1), WindDirection: String(Math.round(w.WindDirection)),
      Rainfall: String(w.Rainfall),
    };
  }

  #raceControl(msg) {
    this.#send('RaceControlMessages', { Messages: { [this.rcm++]: { Utc: utc().slice(0, 19), Lap: this.lapCount, ...msg } } });
  }

  #trackStatus(status, message) {
    this.track_status = status;
    this.#send('TrackStatus', { Status: status, Message: message });
  }

  // ---------------------------------------------------------------- simulation
  #lapTarget(c) {
    const cp = COMPOUND[c.compound];
    let t = c.pace + cp.offset + cp.deg * c.tyreAge + Math.max(0, c.tyreAge - cp.cliff) * 0.22;
    t += 0.03 * Math.max(0, TOTAL_LAPS - c.laps); // fuel
    t += c.lapNoise;
    if (c.pitOut) t += 1.2;
    if (this.track_status === '2') t += 0.4;
    if (this.sc?.kind === 'VSC') t *= 1.32;
    if (this.sc?.kind === 'SC') t *= 1.4;
    if (this.finished && c.finished) t *= 1.5;
    return t;
  }

  #order() {
    return [...this.cars].sort((a, b) => {
      if (a.retired !== b.retired) return a.retired ? 1 : -1;
      return b.prog - a.prog;
    });
  }

  #tick() {
    const dt = (TICK_MS / 1000) * this.speed;
    if (!this.started) {
      this.preT += dt;
      if (this.preT < this.lightsAt) return; // on the grid / formation lap
      this.started = true;
      const now = utc();
      this.#send('SessionStatus', { Status: 'Started' });
      this.#send('SessionData', { StatusSeries: { 0: { Utc: now, SessionStatus: 'Started' } } });
      this.#send('ExtrapolatedClock', { Utc: now, Remaining: '02:00:00', Extrapolating: true });
    }
    const t0 = this.simT;
    this.simT += dt;
    const before = new Map(this.cars.map((c) => [c, c.prog]));

    // 1) move every car
    for (const c of this.cars) {
      if (c.retired || (c.finished && this.finished && c.prog > c.laps + 0.3)) continue;
      if (c.pitTimer > 0) {
        c.pitTimer -= dt;
        if (c.pitTimer <= 0) this.#exitPit(c);
        continue;
      }
      let target = this.#lapTarget(c);
      // Under SC, cars further back close up on the queue.
      if (this.sc?.kind === 'SC') {
        const ahead = this.#carAhead(c);
        if (ahead && (ahead.prog - c.prog) * target > 1.0) target /= 1.25;
      }
      c.prog += dt / target;
    }

    // 2) cars can't drive through each other (except when an overtake happens)
    const order = this.#order().filter((c) => !c.retired);
    for (let i = 1; i < order.length; i++) {
      const c = order[i];
      if (c.pitTimer > 0) continue;
      const ahead = this.#carAhead(c, order, i);
      if (!ahead) continue;
      const minGap = (this.sc?.kind === 'SC' ? 0.5 : 0.25) / this.#lapTarget(c);
      if (c.prog > ahead.prog - minGap) c.prog = Math.max(before.get(c), ahead.prog - minGap);
    }

    // 3) timing loops crossed during this tick
    for (const c of this.cars) {
      const p0 = before.get(c), p1 = c.prog;
      if (p1 <= p0 || c.retired) continue;
      for (let lap = Math.floor(p0); lap <= Math.floor(p1); lap++) {
        for (let k = 0; k < LOOPS.length; k++) {
          const at = lap + LOOPS[k].frac;
          if (at > p0 && at <= p1) {
            const T = t0 + ((at - p0) / (p1 - p0)) * dt;
            this.#loop(c, k, lap, T);
          }
        }
      }
    }

    this.#updatePositions();
    this.#periodic();
    if (this.f1tv) this.#telemetry();
  }

  #carAhead(c, order = this.#order().filter((x) => !x.retired), idx = order.indexOf(c)) {
    for (let j = idx - 1; j >= 0; j--) {
      const a = order[j];
      if (a.pitTimer > 0) continue;
      if (a.prog - c.prog > 0.5) return null; // not really near on track
      return a;
    }
    return null;
  }

  #loop(c, k, lap, T) {
    const L = LOOPS[k];
    const sector = L.sector;
    if (lap < 0) { // crossing the start line from the grid
      c.lapStartT = c.lastSectorT = c.lastLoopT = T;
      return;
    }

    // Segment status; the first loop of a lap also resets the remaining ones.
    const segT = T - c.lastLoopT;
    c.lastLoopT = T;
    let status = 2048;
    if (c.inPit || (c.pitOut && sector === 0)) status = 2064;
    else if (lap > 0 && segT < this.bestSeg[k]) { status = 2051; this.bestSeg[k] = segT; c.segBest[k] = segT; }
    else if (lap > 0 && segT < c.segBest[k]) { status = 2049; c.segBest[k] = segT; }
    if (k === 0) {
      const reset = {};
      SEGMENTS.forEach((n, s) => { reset[s] = { Segments: Object.fromEntries(Array.from({ length: n }, (_, j) => [j, { Status: s === 0 && j === 0 ? status : 0 }])) }; });
      this.#line(c.num, { Sectors: reset });
    } else {
      this.#line(c.num, { Sectors: { [sector]: { Segments: { [L.seg]: { Status: status } } } } });
    }

    // Overtakes happen on the main straight (last part of sector 3).
    if (sector === 2 && L.seg === 4 && !this.sc && this.track_status === '1' && lap >= 1) this.#maybeOvertake(c);

    if (!L.sectorEnd) return;

    // ---- sector end
    const secT = T - c.lastSectorT;
    c.lastSectorT = T;
    const patch = {};
    if (lap >= 1 || sector > 0) {
      const valid = lap >= 1 || sector === 2;
      const sp = { Value: fmtSec(secT), PersonalFastest: false, OverallFastest: false };
      if (valid && !c.inPit && secT < c.sectorBest[sector]) {
        c.sectorBest[sector] = secT;
        sp.PersonalFastest = true;
        if (secT < this.bestSector[sector]) { this.bestSector[sector] = secT; sp.OverallFastest = true; }
        this.#send('TimingStats', { Lines: { [c.num]: { BestSectors: { [sector]: { Value: fmtSec(secT) } } } } });
      }
      patch.Sectors = { [sector]: sp };
    }
    const speedKey = ['I1', 'I2', 'FL'][sector];
    const v = sector === 2 ? c.topSpeed - 18 + rand(-4, 4) : sector === 0 ? 180 + rand(-5, 6) : 245 + rand(-6, 6);
    patch.Speeds = { [speedKey]: { Value: String(Math.round(this.sc ? v * 0.6 : v)) } };
    if (sector === 1) patch.Speeds.ST = { Value: String(Math.round((this.sc ? 0.6 : 1) * (c.topSpeed + rand(-4, 5)))) };

    // gaps at each timing point
    const point = (sector + 1) % 3; // 1 = S1 end, 2 = S2 end, 0 = line
    const lapKey = sector === 2 ? lap + 1 : lap;
    const key = `${lapKey}:${point}`;
    if (!this.crossings.has(key)) this.crossings.set(key, new Map());
    this.crossings.get(key).set(c.num, T);
    Object.assign(patch, this.#gaps(c, key, T));

    if (L.lapEnd) {
      // ---- lap end
      c.laps = lap + 1;
      const lapT = T - c.lapStartT;
      c.lapStartT = T;
      patch.NumberOfLaps = c.laps;
      if (lap >= 1) {
        const lt = { Value: fmtLap(lapT), PersonalFastest: false, OverallFastest: false };
        if (!c.inPit && !c.pitOut && lapT < c.lapBest) {
          c.lapBest = lapT;
          lt.PersonalFastest = true;
          patch.BestLapTime = { Value: fmtLap(lapT), Lap: c.laps };
          if (lapT < this.bestLap) { this.bestLap = lapT; lt.OverallFastest = true; }
          this.#send('TimingStats', { Lines: { [c.num]: { PersonalBestLapTime: { Value: fmtLap(lapT), Lap: c.laps } } } });
        }
        patch.LastLapTime = lt;
      }
      c.pitOut = false;
      patch.PitOut = false;
      c.tyreAge += 1;
      c.lapNoise = gauss() * 0.22;
      this.#send('TimingAppData', { Lines: { [c.num]: { Stints: { [c.stintIdx]: { TotalLaps: c.tyreAge } } } } });

      if (c.laps >= TOTAL_LAPS || this.finished) {
        if (!this.finished) this.#chequered();
        c.finished = true;
      } else {
        const order = this.#order();
        if (order[0] === c) this.#leaderNewLap(c.laps + 1);
        const stop = c.stops[c.stopsDone];
        const scStop = this.sc?.kind === 'SC' && stop && c.laps >= stop.lap - 6 && !c.scStopped;
        if (stop && (c.laps === stop.lap || scStop)) {
          if (scStop) c.scStopped = true;
          this.#enterPit(c, stop.to);
        }
      }
    }
    this.#line(c.num, patch);
  }

  #gaps(c, key, T) {
    const order = this.#order();
    const leader = order[0];
    const idx = order.indexOf(c);
    if (idx === 0) {
      return { GapToLeader: `LAP ${Math.min(TOTAL_LAPS, Math.max(1, Math.floor(c.prog) + 1))}`, IntervalToPositionAhead: { Value: `LAP ${Math.min(TOTAL_LAPS, Math.max(1, Math.floor(c.prog) + 1))}`, Catching: false } };
    }
    const crossing = this.crossings.get(key);
    const lapsDown = Math.floor(leader.prog - c.prog);
    let gap = '';
    if (lapsDown >= 1) gap = `${lapsDown}L`;
    else if (crossing.has(leader.num)) gap = fmtGap(T - crossing.get(leader.num));
    const ahead = order[idx - 1];
    let interval = '', catching = false;
    if (ahead.prog - c.prog >= 1) interval = `${Math.floor(ahead.prog - c.prog)}L`;
    else if (crossing.has(ahead.num)) {
      const iv = T - crossing.get(ahead.num);
      interval = fmtGap(iv);
      catching = c.prevInterval != null && iv < c.prevInterval - 0.05 && iv < 3;
      c.prevInterval = iv;
    }
    const out = {};
    if (gap) out.GapToLeader = gap;
    if (interval) out.IntervalToPositionAhead = { Value: interval, Catching: catching };
    return out;
  }

  #maybeOvertake(c) {
    const order = this.#order().filter((x) => !x.retired);
    const i = order.indexOf(c);
    const ahead = this.#carAhead(c, order, i);
    if (!ahead || ahead.pitTimer > 0) return;
    const gapS = (ahead.prog - c.prog) * this.#lapTarget(c);
    const delta = this.#lapTarget(ahead) - this.#lapTarget(c);
    if (gapS > 0.9 || delta < 0.12) return;
    if (Math.random() < Math.min(0.65, (delta - 0.1) * 1.3)) {
      const swap = ahead.prog;
      ahead.prog = c.prog;
      c.prog = swap + 0.0008;
    }
  }

  #enterPit(c, to) {
    c.inPit = true;
    c.pendingCompound = to;
    c.pitTimer = this.sc?.kind ? rand(13, 15) : rand(20.5, 23);
    this.#line(c.num, { InPit: true, Status: 80 });
  }

  #exitPit(c) {
    const lane = c.pitTimer;
    c.inPit = false;
    c.pitOut = true;
    c.stopsDone += 1;
    c.compound = c.pendingCompound;
    c.tyreAge = 0;
    c.stintIdx += 1;
    const dur = (this.sc?.kind ? rand(13.5, 15) : rand(19.6, 21.8)) + Math.max(0, -lane);
    this.#line(c.num, { InPit: false, PitOut: true, NumberOfPitStops: c.stopsDone, Status: 608 });
    this.#send('TimingAppData', { Lines: { [c.num]: { Stints: { [c.stintIdx]: { LapFlags: 0, Compound: c.compound, New: 'true', TyresNotChanged: '0', TotalLaps: 0, StartLaps: 0 } } } } });
    this.#send('PitLaneTimeCollection', { PitTimes: { [c.num]: { RacingNumber: c.num, Duration: dur.toFixed(1), Lap: String(c.laps + 1) } } });
    if (this.f1tv) {
      // Stationary time is an F1-TV-only topic.
      this.#send('PitStopSeries', { PitTimes: { [c.num]: { [c.stopsDone - 1]: { Timestamp: utc(), PitStop: { RacingNumber: c.num, PitStopTime: rand(2.1, 3.6).toFixed(1), PitLaneTime: dur.toFixed(1), Lap: String(c.laps + 1) } } } } });
    }
  }

  #updatePositions() {
    const order = this.#order();
    const td = {}, app = {};
    order.forEach((c, i) => {
      if (c.position !== i + 1) {
        c.position = i + 1;
        td[c.num] = { Position: String(i + 1), Line: i + 1 };
        app[c.num] = { Line: i + 1 };
      }
    });
    if (Object.keys(td).length) {
      this.#send('TimingData', { Lines: td });
      this.#send('TimingAppData', { Lines: app });
    }
  }

  #leaderNewLap(lap) {
    if (lap <= this.lapCount) return;
    this.lapCount = lap;
    this.#send('LapCount', { CurrentLap: lap, TotalLaps: TOTAL_LAPS });
    const ev = this.events;
    if (lap === ev.yellowLap) {
      this.#trackStatus('2', 'Yellow');
      this.#raceControl({ Category: 'Flag', Flag: 'YELLOW', Scope: 'Sector', Sector: 7, Message: 'YELLOW IN TRACK SECTOR 7' });
      setTimeout(() => { this.#trackStatus('1', 'AllClear'); this.#raceControl({ Category: 'Flag', Flag: 'CLEAR', Scope: 'Sector', Sector: 7, Message: 'CLEAR IN TRACK SECTOR 7' }); }, 18000 / this.speed);
    }
    if (ev.trackLimitsLaps.includes(lap)) {
      const c = pick(this.cars.filter((x) => !x.retired));
      this.#raceControl({ Category: 'Other', Message: `CAR ${c.num} (${c.tla}) TIME ${fmtLap(this.#lapTarget(c) - 0.4)} DELETED - TRACK LIMITS AT TURN ${pick([4, 6, 12])} LAP ${lap - 1}` });
    }
    if (lap === ev.investigateLap) {
      const [a, b] = this.#order().slice(6, 8);
      this.#raceControl({ Category: 'Other', Message: `TURN 1 INCIDENT INVOLVING CARS ${a.num} (${a.tla}) AND ${b.num} (${b.tla}) NOTED - CAUSING A COLLISION` });
      this.penalised = a;
    }
    if (lap === ev.penaltyLap && this.penalised) {
      const a = this.penalised;
      this.#raceControl({ Category: 'Other', Message: `FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR ${a.num} (${a.tla}) - CAUSING A COLLISION` });
    }
    if (lap === ev.vscLap) {
      this.sc = { kind: 'VSC' };
      this.#trackStatus('6', 'VSCDeployed');
      this.#raceControl({ Category: 'SafetyCar', Status: 'DEPLOYED', Mode: 'VIRTUAL SAFETY CAR', Message: 'VIRTUAL SAFETY CAR DEPLOYED' });
      setTimeout(() => {
        this.#trackStatus('7', 'VSCEnding');
        this.#raceControl({ Category: 'SafetyCar', Status: 'ENDING', Mode: 'VIRTUAL SAFETY CAR', Message: 'VIRTUAL SAFETY CAR ENDING' });
        setTimeout(() => { this.sc = null; this.#trackStatus('1', 'AllClear'); }, 9000 / this.speed);
      }, 50000 / this.speed);
    }
    if (lap === ev.scLap) {
      const victim = this.#order()[Math.round(rand(9, 15))];
      victim.retired = true;
      this.#line(victim.num, { Stopped: true, Retired: true, Status: 4, GapToLeader: '', IntervalToPositionAhead: { Value: '' } });
      this.#raceControl({ Category: 'Other', Message: `CAR ${victim.num} (${victim.tla}) STOPPED AT TURN 8` });
      this.#trackStatus('4', 'SCDeployed');
      this.#raceControl({ Category: 'SafetyCar', Status: 'DEPLOYED', Mode: 'SAFETY CAR', Message: 'SAFETY CAR DEPLOYED' });
      this.sc = { kind: 'SC', untilLap: lap + 3 };
    }
    if (this.sc?.kind === 'SC' && lap === this.sc.untilLap) {
      this.#raceControl({ Category: 'SafetyCar', Status: 'IN THIS LAP', Mode: 'SAFETY CAR', Message: 'SAFETY CAR IN THIS LAP' });
    }
    if (this.sc?.kind === 'SC' && lap === this.sc.untilLap + 1) {
      this.sc = null;
      this.#trackStatus('1', 'AllClear');
      this.#raceControl({ Category: 'Flag', Flag: 'GREEN', Scope: 'Track', Message: 'TRACK CLEAR' });
    }
  }

  #chequered() {
    this.finished = true;
    this.#raceControl({ Category: 'Flag', Flag: 'CHEQUERED', Scope: 'Track', Message: 'CHEQUERED FLAG' });
    this.#send('SessionStatus', { Status: 'Finished' });
    // Start a fresh demo race a little later.
    this.restartTimer = setTimeout(() => { this.stop(); this.start(); }, 120000 / this.speed);
  }

  #periodic() {
    if (this.simT >= this.nextWeatherAt) {
      this.nextWeatherAt += 60;
      const w = this.weather;
      w.AirTemp += rand(-0.15, 0.12); w.TrackTemp += rand(-0.4, 0.3); w.Humidity += rand(-0.6, 0.8);
      w.WindSpeed = Math.max(0.3, w.WindSpeed + rand(-0.4, 0.4)); w.WindDirection = (w.WindDirection + rand(-15, 15) + 360) % 360;
      this.#send('WeatherData', this.#weatherMsg());
      const remaining = Math.max(0, 7200 - this.simT);
      const hh = String(Math.floor(remaining / 3600)).padStart(2, '0');
      const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
      const ss = String(Math.floor(remaining % 60)).padStart(2, '0');
      this.#send('ExtrapolatedClock', { Utc: utc(), Remaining: `${hh}:${mm}:${ss}`, Extrapolating: true });
    }
    if (this.simT >= this.nextRadioAt && this.radio.captures?.length) {
      this.nextRadioAt += rand(70, 140);
      const cap = this.radio.captures[this.radioIdx++ % this.radio.captures.length];
      this.#send('TeamRadio', { Captures: { [this.radioIdx - 1]: { Utc: utc(), RacingNumber: cap.RacingNumber, Path: cap.Path } } });
    }
  }

  #telemetry() {
    if (this.simT - this.lastSampleT >= 0.27) {
      this.lastSampleT = this.simT;
      const now = Date.now();
      const cars = {}, pos = {};
      for (const c of this.cars) {
        const frac = ((c.prog % 1) + 1) % 1;
        const s = sampleProfile(this.profile, frac);
        const paceScale = BASE_LAP / this.#lapTarget(c);
        let speed = c.retired ? 0 : s.speed * Math.min(1.02, paceScale);
        if (c.pitTimer > 0) speed = c.pitTimer > 3 ? 80 : 0;
        if (this.sc?.kind === 'SC') speed = Math.min(speed, 175);
        const { gear, rpm } = gearFor(speed);
        const braking = s.accel < -12 && c.pitTimer <= 0;
        const throttle = c.retired || c.pitTimer > 0 ? 0 : braking ? 0 : s.accel < -3 ? Math.round(rand(20, 60)) : 100;
        cars[c.num] = { Channels: { 0: c.retired ? 0 : rpm, 2: Math.round(speed), 3: c.retired ? 0 : gear, 4: throttle, 5: braking ? 100 : 0, 45: 0 } };
        pos[c.num] = { Status: c.retired ? 'Stopped' : 'OnTrack', X: Math.round(s.x), Y: Math.round(s.y), Z: 0 };
      }
      this.telemetryBuf.push({ Utc: utc(now), Cars: cars });
      this.positionBuf.push({ Timestamp: utc(now), Entries: pos });
    }
    if (this.simT - this.lastFlushT >= 1 && this.telemetryBuf.length) {
      this.lastFlushT = this.simT;
      this.#send('CarData', { Entries: this.telemetryBuf });
      this.#send('Position', { Position: this.positionBuf });
      this.telemetryBuf = [];
      this.positionBuf = [];
    }
  }
}
