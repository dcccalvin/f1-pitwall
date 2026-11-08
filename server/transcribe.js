// Team radio transcription. Every clip is turned into text on this laptop with
// OpenAI's Whisper speech model, run locally through Transformers.js: free, no
// account, nothing leaves the laptop, and it keeps working offline once the model
// has been downloaded (first use only, into cache/models/).
//
// Clips are transcribed once, newest first, and saved in cache/transcripts.json.
// Each result has the text plus timed chunks, so screens can show the words as
// they are spoken.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Things Whisper "hears" in engine noise or silence; not speech.
const NOT_SPEECH = /^\s*([[(][^\])]*[\])]|thank you\.?|thanks for watching!?|you|\.+|bye\.?)\s*$/i;

function clean(text) {
  const t = String(text || '').replace(/\s*[[(](?:music|engine|noise|static|silence|blank_audio|inaudible|beep|radio)[^\])]*[\])]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  return NOT_SPEECH.test(t) ? '' : t;
}

/** MP3 bytes -> 16 kHz mono samples, which is what Whisper wants. A fresh decoder per clip
 * (re-using one with reset() makes mpg123 error out and eat memory). */
async function toPcm16k(MPEGDecoder, buf) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  let r;
  try { r = decoder.decode(new Uint8Array(buf)); } finally { decoder.free(); }
  if (!r.samplesDecoded) throw new Error('could not decode the clip');
  const L = r.channelData[0], R = r.channelData[1] || L;
  const ratio = r.sampleRate / 16000;
  const out = new Float32Array(Math.floor(L.length / ratio));
  for (let i = 0; i < out.length; i++) { // average each 16 kHz step's samples: a simple low-pass + resample
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b; k++) s += (L[k] + R[k]) / 2;
    out[i] = s / (b - a);
  }
  return out;
}

export class Transcriber extends EventEmitter {
  /**
   * getClip(path) -> Promise<Buffer> of the mp3 (shared with the radio proxy and its cache).
   * model: a Whisper model on Hugging Face in ONNX form.
   */
  constructor({ cacheDir, getClip, model = 'onnx-community/whisper-small.en', dtype = 'q8', enabled = true, log = console }) {
    super();
    this.cacheDir = cacheDir;
    this.getClip = getClip;
    this.model = model;
    this.dtype = dtype;
    this.log = log;
    this.file = path.join(cacheDir, 'transcripts.json');
    this.done = {};
    try { this.done = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* none yet */ }
    this.queue = [];
    this.busy = false;
    this.state = enabled ? 'idle' : 'off'; // idle | loading | ready | working | unavailable | off
    this.detail = '';
  }

  status() {
    return { state: this.state, detail: this.detail, queued: this.queue.length, model: this.model };
  }

  /** Saved transcripts whose clip path starts with `prefix` (one session's). */
  forSession(prefix) {
    const out = {};
    for (const [k, v] of Object.entries(this.done)) if (!prefix || k.startsWith(prefix)) out[k] = v;
    return out;
  }

  /** Queue a clip. urgent = a new live clip: goes before any backlog. */
  add(clipPath, { urgent = false } = {}) {
    if (this.state === 'off' || this.state === 'unavailable' || !clipPath) return;
    if (this.done[clipPath] || this.queue.includes(clipPath) || this.current === clipPath) return;
    if (urgent) this.queue.unshift(clipPath); else this.queue.push(clipPath);
    this.#pump();
  }

  async #load() {
    if (this.asr) return this.asr;
    this.state = 'loading';
    this.detail = fs.existsSync(path.join(this.cacheDir, 'models')) ? 'Loading the speech model' : 'Downloading the speech model (first time only)';
    this.emit('status', this.status());
    let tf, mpg;
    try {
      tf = await import('@huggingface/transformers');
      mpg = await import('mpg123-decoder');
    } catch {
      this.state = 'unavailable';
      this.detail = 'Speech model not installed: run "npm install" in the Pit Wall folder';
      this.queue = [];
      this.log.warn?.(`[radio] transcription unavailable: ${this.detail}`);
      this.emit('status', this.status());
      return null;
    }
    tf.env.cacheDir = path.join(this.cacheDir, 'models');
    this.MPEGDecoder = mpg.MPEGDecoder;
    const t = Date.now();
    this.asr = await tf.pipeline('automatic-speech-recognition', this.model, { dtype: this.dtype, device: 'cpu' });
    this.log.log?.(`[radio] speech model ready (${this.model}, ${Math.round((Date.now() - t) / 1000)}s)`);
    this.state = 'ready';
    this.detail = '';
    this.emit('status', this.status());
    return this.asr;
  }

  async #pump() {
    if (this.busy) return;
    this.busy = true;
    clearTimeout(this.idleTimer);
    try {
      while (this.queue.length) {
        const asr = await this.#load().catch((e) => {
          this.state = 'unavailable';
          this.detail = `Speech model failed to load: ${e.message}`;
          this.log.warn?.(`[radio] ${this.detail}`);
          this.emit('status', this.status());
          return null;
        });
        if (!asr) { this.queue = []; break; }
        const clip = this.current = this.queue.shift();
        this.state = 'working';
        try {
          const audio = await toPcm16k(this.MPEGDecoder, await this.getClip(clip));
          const t = Date.now();
          const r = await asr(audio, { return_timestamps: true });
          const entry = {
            text: clean(r.text),
            chunks: (r.chunks || []).map((c) => ({ t: c.timestamp, text: clean(c.text) })).filter((c) => c.text),
            secs: +(audio.length / 16000).toFixed(1),
            took: Date.now() - t,
            model: this.model.split('/').pop(),
          };
          this.done[clip] = entry;
          this.#save();
          this.emit('text', clip, entry);
        } catch (e) {
          this.log.warn?.(`[radio] could not transcribe ${clip.split('/').pop()}: ${e.message}`);
        }
        this.current = null;
      }
    } finally {
      this.busy = false;
      if (this.state === 'working') this.state = 'ready';
      this.emit('status', this.status());
      // Free the memory (~1 GB) when nothing has come in for a while; it reloads in seconds.
      this.idleTimer = setTimeout(() => this.#unload(), 20 * 60000);
    }
  }

  async #unload() {
    if (this.busy || !this.asr) return;
    try { await this.asr.dispose?.(); } catch { /* ignore */ }
    this.asr = null;
    this.state = 'idle';
    this.emit('status', this.status());
  }

  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.done));
      } catch (e) { this.log.warn?.(`[radio] could not save transcripts: ${e.message}`); }
    }, 1000);
  }
}
