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
 *  'status' ({state, detail})      connection state changes
 */
export class F1Feed extends EventEmitter {
  constructor({ token = null, log = console } = {}) {
    super();
    this.token = token;
    this.log = log;
    this.conn = null;
    this.stopped = false;
    this.retryMs = 2000;
  }

  get topics() {
    return this.token ? [...FREE_TOPICS, ...AUTH_TOPICS] : FREE_TOPICS;
  }

  async start() {
    this.stopped = false;
    await this.#connect();
  }

  async stop() {
    this.stopped = true;
    if (this.conn) await this.conn.stop().catch(() => {});
  }

  #status(state, detail = '') {
    this.emit('status', { state, detail, authenticated: !!this.token });
  }

  async #connect() {
    const opts = { transport: signalR.HttpTransportType.WebSockets };
    if (this.token) opts.accessTokenFactory = () => this.token;
    this.conn = new signalR.HubConnectionBuilder()
      .withUrl(HUB_URL, opts)
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(30000, 1000 * 2 ** ctx.previousRetryCount) })
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    this.conn.serverTimeoutInMilliseconds = 60000;

    this.conn.on('feed', (topic, data, ts) => {
      try {
        const [t, d] = normalise(topic, data);
        // A new session (e.g. practice -> qualifying) on the same connection:
        // reconnect so we start from a clean full state (onclose reconnects).
        if (t === 'SessionInfo' && d?.Key && this.sessionKey && d.Key !== this.sessionKey) {
          this.sessionKey = d.Key;
          this.conn.stop().catch(() => {});
          return;
        }
        this.emit('feed', t, d, ts);
      } catch (e) {
        this.log.warn?.(`[feed] could not decode ${topic}: ${e.message}`);
      }
    });
    this.conn.onreconnecting(() => this.#status('reconnecting'));
    this.conn.onreconnected(() => this.#subscribe().catch((e) => this.#status('error', e.message)));
    this.conn.onclose((err) => {
      this.#status('disconnected', err?.message || '');
      if (!this.stopped) setTimeout(() => this.#connect().catch(() => {}), this.retryMs);
    });

    this.#status('connecting');
    try {
      await this.conn.start();
      await this.#subscribe();
    } catch (e) {
      this.#status('error', e.message);
      if (!this.stopped) setTimeout(() => this.#connect().catch(() => {}), Math.min(30000, (this.retryMs *= 1.5)));
    }
  }

  async #subscribe() {
    const res = (await this.conn.invoke('Subscribe', this.topics)) || {};
    const state = {};
    for (const [topic, value] of Object.entries(res)) {
      try {
        const [t, d] = normalise(topic, value);
        state[t] = d;
      } catch (e) {
        this.log.warn?.(`[feed] could not decode initial ${topic}: ${e.message}`);
      }
    }
    this.retryMs = 2000;
    this.sessionKey = state.SessionInfo?.Key ?? this.sessionKey;
    this.#status('live', this.token ? 'F1 TV data enabled' : 'free data');
    this.emit('init', state);
  }
}
