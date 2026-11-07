// Stand-alone recorder: `npm run record` saves the live feed to recordings/ without the dashboard.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { F1Feed } from './f1feed.js';
import { Recorder } from './recorder.js';
import { loadConfig } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(root);
const rec = new Recorder(path.join(root, 'recordings'));
const feed = new F1Feed({ token: cfg.f1tvToken });
let n = 0;
feed.on('status', (s) => console.log(`[record] ${s.state} ${s.detail}`));
feed.on('init', (state) => { rec.init(state); console.log(`[record] writing ${rec.file}`); });
feed.on('feed', (topic, data, ts) => { rec.feed(topic, data, ts); if (++n % 500 === 0) console.log(`[record] ${n} messages`); });
process.on('SIGINT', async () => { await feed.stop(); rec.close(); process.exit(0); });
feed.start();
