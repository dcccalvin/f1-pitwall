// Writes the raw feed to a JSON-lines file so any session you watch can be replayed later.
// Line format:
//   {"t":<ms epoch>,"type":"init","data":{...full state...}}
//   {"t":<ms epoch>,"type":"feed","topic":"TimingData","data":{...},"ts":"<feed timestamp>"}
//
// Only one program records at a time: a lock file with a heartbeat stops a second
// Pit Wall (or `npm run record`) from writing every message into the same file twice.
import fs from 'node:fs';
import path from 'node:path';

const LOCK_STALE_MS = 30000;

/** Where a session's recording lives (one file per session). */
export function recordingPath(dir, state) {
  const info = state?.SessionInfo || {};
  const name = [
    (info.StartDate || new Date().toISOString()).slice(0, 10),
    info.Meeting?.Name || 'session',
    info.Name || '',
  ].join(' ').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_');
  return path.join(dir, `${name}.jsonl`);
}

export class Recorder {
  constructor(dir, { log = console } = {}) {
    this.dir = dir;
    this.log = log;
    this.stream = null;
    this.file = null;
    this.sessionKey = null;
    this.lockFile = path.join(dir, '.recording.lock');
    this.hasLock = false;
    this.warned = false;
  }

  /** Take the recording lock unless another live process holds it. */
  #lock() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const cur = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      const fresh = Date.now() - cur.heartbeat < LOCK_STALE_MS;
      if (fresh && cur.pid !== process.pid && isAlive(cur.pid)) {
        if (!this.warned) this.log.warn?.(`[record] another Pit Wall (pid ${cur.pid}) is already recording; this one won't.`);
        this.warned = true;
        return false;
      }
    } catch { /* no lock yet */ }
    fs.writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
    if (!this.beat) this.beat = setInterval(() => this.#heartbeat(), 10000).unref?.() ?? null;
    this.hasLock = true;
    return true;
  }

  #heartbeat() {
    if (!this.hasLock) return;
    try { fs.writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, heartbeat: Date.now() })); } catch { /* ignore */ }
  }

  #open(state) {
    const info = state?.SessionInfo || {};
    const key = `${info.Meeting?.Key ?? 'x'}-${info.Key ?? 'x'}`;
    if (this.stream && key === this.sessionKey) return;
    this.close(false);
    if (!this.hasLock && !this.#lock()) return;
    this.file = recordingPath(this.dir, state);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.sessionKey = key;
  }

  init(state, t = Date.now()) {
    if (state?.SessionInfo?.Demo || state?.SessionInfo?.Replay) return; // never record demos/replays
    this.#open(state);
    this.stream?.write(JSON.stringify({ t, type: 'init', data: state }) + '\n');
  }

  feed(topic, data, ts, t = Date.now()) {
    if (!this.stream) return;
    this.stream.write(JSON.stringify({ t, type: 'feed', topic, data, ts }) + '\n');
  }

  close(release = true) {
    this.stream?.end();
    this.stream = null;
    if (release && this.hasLock) {
      clearInterval(this.beat);
      this.beat = null;
      try {
        const cur = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
        if (cur.pid === process.pid) fs.unlinkSync(this.lockFile);
      } catch { /* already gone */ }
      this.hasLock = false;
    }
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
