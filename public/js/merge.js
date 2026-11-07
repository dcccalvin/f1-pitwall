// Applies F1 live-timing updates to a state object. Shared by the server and the browser.
//
// The feed sends a full object per topic first, then partial updates that must be
// deep-merged. Arrays are updated with objects keyed by index ({"3": {...}}), and
// "_deleted": [keys] removes entries.

// Topics whose payload is a fresh batch each time (not a patch).
const REPLACE_TOPICS = new Set(['CarData', 'Position']);

export const INIT = '__init';

export function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

export function deepMerge(target, src) {
  if (!isObj(src)) return src;
  if (Array.isArray(src)) return clone(src);

  if (Array.isArray(target)) {
    for (const [k, v] of Object.entries(src)) {
      if (k === '_deleted') continue;
      const i = Number(k);
      if (Number.isInteger(i)) target[i] = deepMerge(target[i], v);
    }
    return target;
  }

  if (!isObj(target)) target = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === '_deleted') {
      for (const d of v || []) delete target[d];
      continue;
    }
    target[k] = deepMerge(target[k], v);
  }
  return target;
}

/** Mutates `state` in place. */
export function applyMessage(state, topic, data) {
  if (topic === INIT) {
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, clone(data));
    return state;
  }
  if (REPLACE_TOPICS.has(topic) || !isObj(state[topic]) || !isObj(data)) {
    state[topic] = clone(data);
    return state;
  }
  state[topic] = deepMerge(state[topic], data);
  return state;
}
