// Plays back a recording made by the recorder, like a video: play, pause,
// change speed and jump to any moment.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { applyMessage, INIT } from '../public/js/merge.js';

/** A recording's messages, from its first full state on, with duplicates dropped. */
export function readRecording(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const entries = [];
  // Recordings made by two programs at once contain every message twice;
  // drop exact repeats (same topic, feed timestamp and payload).
  const recent = new Set();
  const order = [];
  for (const l of lines) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; /* partial last line */ }
    if (!Number.isFinite(e?.t)) continue;
    if (e.type === 'feed') {
      const k = `${e.topic}|${e.ts}|${JSON.stringify(e.data)}`;
      if (recent.has(k)) continue;
      recent.add(k); order.push(k);
      if (order.length > 400) recent.delete(order.shift());
    } else if (e.type === 'init') {
      const prev = entries.findLast((x) => x.type === 'init');
      if (prev && e.t - prev.t < 3000) continue; // duplicate full-state snapshot
    } else continue;
    entries.push(e);
  }
  const first = entries.findIndex((e) => e.type === 'init');
  if (first < 0) throw new Error('recording has no initial state');
  return entries.slice(first);
}

/** Moments worth jumping to: starts and restarts, red flags, safety cars, the chequered flag. */
export function findMarks(entries) {
  const t0 = entries[0].t;
  const marks = [];
  let session = null, track = null;
  const add = (e, kind) => {
    const at = (e.t - t0) / 1000;
    // Red flags arrive as both a session and a track status: keep one.
    if (marks.some((m) => m.kind === kind && at - m.at < 20)) return;
    marks.push({ at: Math.round(at), kind });
  };
  for (const e of entries) {
    let ss, ts;
    if (e.type === 'init') { ss = e.data?.SessionStatus?.Status; ts = e.data?.TrackStatus?.Status; }
    else if (e.topic === 'SessionStatus') ss = e.data?.Status;
    else if (e.topic === 'TrackStatus') ts = e.data?.Status;
    if (ss && ss !== session) {
      if (session !== null) {
        if (ss === 'Started') add(e, 'start');
        else if (ss === 'Aborted') add(e, 'red');
        else if (ss === 'Finished') add(e, 'end');
      }
      session = ss;
    }
    if (ts && String(ts) !== track) {
      if (track !== null) {
        if (ts === '4') add(e, 'sc');
        else if (ts === '6') add(e, 'vsc');
        else if (ts === '5') add(e, 'red');
      }
      track = String(ts);
    }
  }
  return marks;
}

// Topics that mean something is happening (the recorder keeps logging heartbeats
// and weather long after a session ends; those don't make a replay longer).
const ACTIVE = new Set(['TimingData', 'TimingAppData', 'TimingStats', 'RaceControlMessages', 'TeamRadio', 'SessionStatus', 'TrackStatus', 'LapCount', 'PitLaneTimeCollection', 'Position', 'CarData']);

/** Length of the useful part of a recording, in ms (up to 2 minutes after the last real update). */
function activeLength(entries) {
  const t0 = entries[0].t;
  for (let i = entries.length - 1; i > 0; i--) {
    if (ACTIVE.has(entries[i].topic)) return Math.min(entries.at(-1).t, entries[i].t + 120000) - t0;
  }
  return entries.at(-1).t - t0;
}

/** SessionInfo.StartDate is local track time; GmtOffset turns it into UTC ms. */
function scheduledUtc(info) {
  const local = Date.parse(`${String(info?.StartDate || '').slice(0, 19)}Z`);
  if (isNaN(local)) return null;
  const m = /^(-)?(\d+):(\d+)/.exec(info?.GmtOffset || '');
  const off = m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return local - off * 60000;
}

/** Title, length and a sensible place to start watching, for the replay list. */
export function describe(file, entries = readRecording(file)) {
  const info = entries[0].data?.SessionInfo || {};
  const t0 = entries[0].t;
  const dur = activeLength(entries) / 1000;
  const marks = findMarks(entries).filter((m) => m.at <= dur);
  const first = marks.find((m) => m.kind === 'start');
  // Start a minute before the scheduled start (so a race shows the formation lap),
  // else a minute before the first start in the recording, else at the beginning.
  const sched = scheduledUtc(info);
  let startAt = 0;
  if (sched && sched - t0 > 60000 && sched - t0 < dur * 1000) startAt = (sched - t0) / 1000 - 60;
  else if (first) startAt = Math.max(0, first.at - 60);
  return {
    name: path.basename(file),
    meeting: info.Meeting?.Name || '',
    session: info.Name || path.basename(file, '.jsonl').replace(/_/g, ' '),
    circuit: info.Meeting?.Circuit?.ShortName || '',
    demo: !!info.Demo || /demo/i.test(path.basename(file)),
    startDate: info.StartDate || null,
    gmtOffset: info.GmtOffset || null,
    recordedAt: t0,
    dur: Math.round(dur),
    startAt: Math.round(startAt),
    marks,
  };
}

export class Replayer extends EventEmitter {
  constructor(file, { speed = 1, skipSeconds = null } = {}) {
    super();
    this.file = file;
    this.speed = speed;
    this.skipSeconds = skipSeconds;
    this.paused = false;
    this.ended = false;
  }

  start() {
    this.entries = readRecording(this.file);
    this.meta = describe(this.file, this.entries);
    this.t0 = this.entries[0].t;
    this.dur = this.meta.dur * 1000;
    this.seek(this.skipSeconds ?? this.meta.startAt);
  }

  /** Recording position in ms, right now. */
  position() {
    if (this.paused || this.ended) return this.pos;
    return Math.min(this.dur, this.basePos + (Date.now() - this.base) * this.speed);
  }

  info() {
    const pos = this.position();
    return {
      ...this.meta, file: this.meta.name, pos: pos / 1000, recT: this.t0 + pos,
      speed: this.speed, paused: this.paused, ended: this.ended, at: Date.now(),
    };
  }

  #changed() {
    this.emit('replay', this.info());
  }

  /** Jump to `sec` into the recording: rebuild the state there and carry on from it. */
  seek(sec) {
    clearTimeout(this.timer);
    const ms = Math.max(0, Math.min(this.dur, Number(sec) * 1000 || 0));
    const state = {};
    let i = 0;
    for (; i < this.entries.length && this.entries[i].t - this.t0 <= ms; i++) {
      const e = this.entries[i];
      applyMessage(state, e.type === 'init' ? INIT : e.topic, e.data);
      this.emit('skip', e, state);
    }
    this.i = i;
    this.pos = ms;
    this.ended = false;
    this.base = Date.now();
    this.basePos = ms;
    if (state.SessionInfo) state.SessionInfo.Replay = true;
    this.emit('status', { state: 'replay', detail: this.meta.name, authenticated: !!state.CarData });
    this.emit('init', state);
    this.#changed();
    if (!this.paused) this.#step();
  }

  #step() {
    const pos = this.position();
    while (this.i < this.entries.length && this.entries[this.i].t - this.t0 <= pos) {
      const e = this.entries[this.i++];
      if (e.type === 'init') {
        if (e.data.SessionInfo) e.data.SessionInfo.Replay = true;
        this.emit('init', e.data);
      } else this.emit('feed', e.topic, e.data, e.ts);
    }
    this.pos = pos;
    if (this.i >= this.entries.length || pos >= this.dur) {
      this.pos = this.dur;
      this.ended = true;
      this.#changed();
      return;
    }
    this.timer = setTimeout(() => this.#step(), 50);
  }

  pause() {
    if (this.paused) return;
    this.pos = this.position();
    this.paused = true;
    clearTimeout(this.timer);
    this.#changed();
  }

  play() {
    if (this.ended) { this.paused = false; this.seek(0); return; }
    if (!this.paused) return;
    this.paused = false;
    this.base = Date.now();
    this.basePos = this.pos;
    this.#changed();
    this.#step();
  }

  setSpeed(x) {
    this.pos = this.position();
    this.speed = Math.max(0.25, Math.min(60, Number(x) || 1));
    this.base = Date.now();
    this.basePos = this.pos;
    this.#changed();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
