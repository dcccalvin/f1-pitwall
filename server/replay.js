// Plays back a recording made by the recorder at real speed (or faster).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { applyMessage, INIT } from '../public/js/merge.js';

export class Replayer extends EventEmitter {
  constructor(file, { speed = 1, skipSeconds = 0, loop = true } = {}) {
    super();
    this.file = file;
    this.speed = speed;
    this.skipSeconds = skipSeconds;
    this.loop = loop;
  }

  start() {
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    this.entries = [];
    // Recordings made by two programs at once contain every message twice;
    // drop exact repeats (same topic, feed timestamp and payload).
    const recent = new Set();
    const order = [];
    for (const l of lines) {
      let e;
      try { e = JSON.parse(l); } catch { continue; /* partial last line */ }
      if (e.type === 'feed') {
        const k = `${e.topic}|${e.ts}|${JSON.stringify(e.data)}`;
        if (recent.has(k)) continue;
        recent.add(k); order.push(k);
        if (order.length > 400) recent.delete(order.shift());
      } else if (e.type === 'init') {
        const prev = this.entries.findLast((x) => x.type === 'init');
        if (prev && e.t - prev.t < 3000) continue; // duplicate full-state snapshot
      }
      this.entries.push(e);
    }
    const first = this.entries.findIndex((e) => e.type === 'init');
    if (first < 0) throw new Error('recording has no initial state');
    this.entries = this.entries.slice(first);
    this.#play();
  }

  #play() {
    const t0 = this.entries[0].t;
    const startAt = t0 + this.skipSeconds * 1000;
    // Fast-forward to the skip point, then send the result as the initial state.
    const state = {};
    let i = 0;
    for (; i < this.entries.length && this.entries[i].t <= startAt; i++) {
      const e = this.entries[i];
      applyMessage(state, e.type === 'init' ? INIT : e.topic, e.data);
      this.emit('skip', e, state);
    }
    this.emit('status', { state: 'replay', detail: `${(this.speed !== 1 ? `${this.speed}× · ` : '')}${this.file.split(/[\\/]/).pop()}`, authenticated: !!state.CarData });
    if (state.SessionInfo) state.SessionInfo.Replay = true;
    this.emit('init', state);

    const wallStart = Date.now();
    const step = () => {
      const elapsed = (Date.now() - wallStart) * this.speed;
      while (i < this.entries.length && this.entries[i].t - startAt <= elapsed) {
        const e = this.entries[i++];
        if (e.type === 'init') {
          if (e.data.SessionInfo) e.data.SessionInfo.Replay = true;
          this.emit('init', e.data);
        } else this.emit('feed', e.topic, e.data, e.ts);
      }
      if (i >= this.entries.length) {
        this.emit('status', { state: 'replay', detail: 'finished' });
        if (this.loop) this.timer = setTimeout(() => this.#play(), 10000);
        return;
      }
      this.timer = setTimeout(step, 50);
    };
    step();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
