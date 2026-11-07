// Settings live in config.json (optional). Environment variables override it.
//   port         web server port (default 3000)
//   f1tvToken    F1 TV subscription token — leave empty for free data.
//   defaultDelay seconds of delay new screens start with (to match your TV)
import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(root) {
  let file = {};
  const p = path.join(root, 'config.json');
  if (fs.existsSync(p)) {
    try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.warn(`[config] ignoring invalid config.json: ${e.message}`); }
  }
  const token = (process.env.F1TV_TOKEN ?? file.f1tvToken ?? '').trim();
  return {
    port: Number(process.env.PORT ?? file.port ?? 3000),
    f1tvToken: token || null,
    defaultDelay: Number(process.env.DEFAULT_DELAY ?? file.defaultDelay ?? 0),
  };
}

export function saveConfig(root, patch) {
  const p = path.join(root, 'config.json');
  let cur = {};
  if (fs.existsSync(p)) { try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {} }
  fs.writeFileSync(p, JSON.stringify({ ...cur, ...patch }, null, 2));
}
