// Writes the raw feed to a JSON-lines file so any session you watch can be replayed later.
// Line format:
//   {"t":<ms epoch>,"type":"init","data":{...full state...}}
//   {"t":<ms epoch>,"type":"feed","topic":"TimingData","data":{...},"ts":"<feed timestamp>"}
import fs from 'node:fs';
import path from 'node:path';

export class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.stream = null;
    this.file = null;
    this.sessionKey = null;
  }

  #open(state) {
    const info = state?.SessionInfo || {};
    const key = `${info.Meeting?.Key ?? 'x'}-${info.Key ?? 'x'}`;
    if (this.stream && key === this.sessionKey) return;
    this.close();
    fs.mkdirSync(this.dir, { recursive: true });
    const name = [
      (info.StartDate || new Date().toISOString()).slice(0, 10),
      info.Meeting?.Name || 'session',
      info.Name || '',
    ].join(' ').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_');
    this.file = path.join(this.dir, `${name}.jsonl`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.sessionKey = key;
  }

  init(state, t = Date.now()) {
    this.#open(state);
    this.stream.write(JSON.stringify({ t, type: 'init', data: state }) + '\n');
  }

  feed(topic, data, ts, t = Date.now()) {
    if (!this.stream) return;
    this.stream.write(JSON.stringify({ t, type: 'feed', topic, data, ts }) + '\n');
  }

  close() {
    this.stream?.end();
    this.stream = null;
  }
}
