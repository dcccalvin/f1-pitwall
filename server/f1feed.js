// Connection to F1's live timing feed (SignalR Core).
// Free topics work without login. If an F1 TV token is configured, the hub also
// sends CarData (speed/throttle/brake/gear/rpm) and Position (car x/y on track).
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import * as signalR from '@microsoft/signalr';

export const FREE_TOPICS = [
  'Heartbeat', 'ExtrapolatedClock', 'TopThree', 'TimingStats', 'TimingAppData',
  'WeatherData', 'TrackStatus', 'SessionStatus', 'DriverList', 'RaceControlMessages',
  'SessionInfo', 'SessionData', 'LapCount', 'TimingData', 'TeamRadio',
  'PitLaneTimeCollection', 'RcmSeries',
];
// Only delivered to connections signed in with F1 TV (Access tier or higher).
export const AUTH_TOPICS = ['CarData.z', 'Position.z', 'ChampionshipPrediction', 'PitStopSeries'];

const HUB_URL = 'https://livetiming.formula1.com/signalrcore';

export function decodeZ(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(zlib.inflateRawSync(Buffer.from(value, 'base64')).toString('utf8'));
}

/** Normalises a topic name + payload: inflates ".z" topics and drops the suffix. */
export function normalise(topic, data) {
  if (topic.endsWith('.z')) return [topic.slice(0, -2), decodeZ(data)];
  return [topic, data];
}

/**
 * Emits:
 *  'init'   (fullState)            after each (re)subscribe
 *  'feed'   (topic, data, ts)      for every incremental update
 *  'status' ({state, detail, ...}) connection state changes:
 *      connecting | live | reconnecting | offline (no internet / F1 unreachable)
 *
 * Reconnects on its own after any drop: 1, 2, 4, 8 s, then every 15 s, so it
 * recovers within seconds of the internet coming back. A watchdog also forces a
 * fresh connection if F1 goes silent while data should be flowing.
 */
const NETWORK_ERR = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|socket hang up|network|WebSocket failed/i;
const SILENCE_MS = 45000;

export class F1Feed extends EventEmitter {
  constructor({ token = null, log = console, hubUrl = process.env.F1_HUB_URL || HUB_URL } = {}) {
    super();
    this.token = token;
    this.log = log;
    this.hubUrl = hubUrl;
    this.conn = null;
    this.stopped = false;
    this.attempt = 0;
    this.state = 'idle';
    this.lastDataAt = 0;
    this.downSince = null;
    this.retryAt = null;
    this.heartbeats = false;
  }

  get topics() {
    return this.token ? [...FREE_TOPICS, ...AUTH_TOPICS] : FREE_TOPICS;
  }

  async start() {
    this.stopped = false;
    clearInterval(this.dog);
    this.dog = setInterval(() => this.#watchdog(), 5000);
    await this.#connect();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.dog);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const c = this.conn;
    this.conn = null;
    if (c) await c.stop().catch(() => {});
  }

  #status(state, detail = '', extra = {}) {
    this.state = state;
    this.emit('status', {
      state, detail, authenticated: !!this.token,
      lastDataAt: this.lastDataAt || null, downSince: this.downSince, retryAt: this.retryAt, ...extra,
    });
  }

  /** Something broke: say what, and try again soon (backing off to every 15 s). */
  #retry(reason) {
    if (this.stopped || this.retryTimer) return;
    this.attempt += 1;
    const wait = Math.min(15000, 1000 * 2 ** Math.min(this.attempt - 1, 4));
    this.retryAt = Date.now() + wait;
    if (!this.downSince) this.downSince = Date.now();
    const offline = NETWORK_ERR.test(reason || '');
    this.log.warn?.(`[feed] ${offline ? 'offline' : 'connection lost'}: ${reason || 'closed'}; retrying in ${Math.round(wait / 1000)}s`);
    this.#status(offline ? 'offline' : 'reconnecting', offline ? 'No internet, or F1 cannot be reached' : (reason || 'Connection closed'));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.#connect(); }, wait);
  }

  #watchdog() {
    if (this.stopped || this.state !== 'live' || !this.conn) return;
    // F1 sends a heartbeat every ~15 s while a session is on; silence means a dead link.
    if (this.heartbeats && Date.now() - this.lastDataAt > SILENCE_MS) {
      const c = this.conn;
      this.conn = null;
      c.stop().catch(() => {});
      this.#retry(`No data from F1 for ${Math.round(SILENCE_MS / 1000)} s`);
    }
  }

  async #connect() {
    if (this.stopped) return;
    const opts = { transport: signalR.HttpTransportType.WebSockets };
    if (this.token) opts.accessTokenFactory = () => this.token;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(this.hubUrl, opts)
      .configureLogging(signalR.LogLevel.None) // we report problems ourselves, in plain words
      .build();
    conn.serverTimeoutInMilliseconds = 35000; // a silent drop is noticed within ~35 s
    conn.keepAliveIntervalInMilliseconds = 10000;
    this.conn = conn;
    this.heartbeats = false;

    conn.on('feed', (topic, data, ts) => {
      if (this.conn !== conn) return;
      this.lastDataAt = Date.now();
      if (topic === 'Heartbeat') this.heartbeats = true;
      try {
        const [t, d] = normalise(topic, data);
        // A new session (e.g. practice -> qualifying) on the same connection:
        // reconnect so we start from a clean full state.
        if (t === 'SessionInfo' && d?.Key && this.sessionKey && d.Key !== this.sessionKey) {
          this.sessionKey = d.Key;
          this.conn = null;
          conn.stop().catch(() => {});
          this.attempt = 0;
          this.#connect();
          return;
        }
        this.emit('feed', t, d, ts);
      } catch (e) {
        this.log.warn?.(`[feed] could not decode ${topic}: ${e.message}`);
      }
    });
    conn.onclose((err) => {
      if (this.conn !== conn || this.stopped) return; // replaced or stopped on purpose
      this.conn = null;
      this.#retry(err?.message || 'Connection closed');
    });

    this.#status(this.downSince ? 'reconnecting' : 'connecting', this.downSince ? 'Reconnecting to F1' : '');
    try {
      await conn.start();
      if (this.conn !== conn) return;
      await this.#subscribe(conn);
    } catch (e) {
      if (this.conn !== conn) return;
      this.conn = null;
      conn.stop().catch(() => {});
      this.#retry(e?.message || String(e));
    }
  }

  async #subscribe(conn) {
    const res = (await conn.invoke('Subscribe', this.topics)) || {};
    const state = {};
    for (const [topic, value] of Object.entries(res)) {
      try {
        const [t, d] = normalise(topic, value);
        state[t] = d;
      } catch (e) {
        this.log.warn?.(`[feed] could not decode initial ${topic}: ${e.message}`);
      }
    }
    const downFor = this.downSince ? Date.now() - this.downSince : 0;
    this.attempt = 0;
    this.downSince = null;
    this.retryAt = null;
    this.lastDataAt = Date.now();
    this.sessionKey = state.SessionInfo?.Key ?? this.sessionKey;
    if (downFor) this.log.log?.(`[feed] back online after ${Math.round(downFor / 1000)}s`);
    this.#status('live', this.token ? 'F1 TV data enabled' : 'free data', downFor ? { recoveredAfter: downFor } : {});
    this.emit('init', state);
  }
}
