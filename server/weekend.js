// What's next this weekend, for the screen shown between sessions:
//   - the next session and when it starts
//   - before a race or sprint: the starting grid (after grid penalties), the
//     qualifying order it came from, and F1's note on why they differ
//   - the weather forecast for the start
//
// Sources (all free, no account): OpenF1 (sessions, qualifying result, starting
// grid, drivers), formula1.com's starting-grid page (penalty note, and the grid
// itself if OpenF1 doesn't have it yet), Open-Meteo (forecast).

const UA = { 'user-agent': 'pitwall-dashboard' };
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenF1's free tier allows a few requests a second: space them out, retry when told to wait.
let lastCall = 0;
async function json(url, tries = 3) {
  const wait = lastCall + 400 - Date.now();
  lastCall = Math.max(Date.now(), lastCall + 400);
  if (wait > 0) await sleep(wait);
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (r.status === 429 && tries > 1) { await sleep(1500); return json(url, tries - 1); }
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function page(url) {
  const r = await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.text())
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** formula1.com results table "Pos. No. Driver Team Time" -> rows, plus the "Note - ..." under it. */
export function parseGridPage(text) {
  const start = text.search(/Pos\.? No\.? Driver Team/i);
  if (start < 0) return { rows: [], note: '' };
  const end = text.indexOf('OUR PARTNERS', start);
  let body = text.slice(start, end > 0 ? end : start + 6000);
  const noteAt = body.search(/\bNotes?\s*[-:–]/);
  const note = noteAt > 0 ? body.slice(noteAt).replace(/^Notes?\s*[-:–]\s*/, '').trim() : '';
  if (noteAt > 0) body = body.slice(0, noteAt);
  const tok = body.split(' ').filter(Boolean);
  const rows = [];
  let want = 1;
  for (let i = 0; i < tok.length - 2; i++) {
    if (tok[i] !== String(want) || !/^\d{1,2}$/.test(tok[i + 1])) continue;
    let k = i + 2;
    while (k < tok.length && k < i + 9 && !/^[A-Z]{3}$/.test(tok[k])) k++;
    if (!/^[A-Z]{3}$/.test(tok[k] || '')) continue;
    rows.push({ pos: want, num: tok[i + 1], tla: tok[k] });
    want++;
    i = k;
  }
  return { rows, note };
}

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20 };

/** Why one driver's grid slot differs from qualifying, from F1's note: { what, why, text }. */
export function reasonFor(note, lastName) {
  if (!note || !lastName) return null;
  const sentences = note.split(/(?<=\.)\s+/);
  const name = plain(lastName);
  for (const s of sentences) {
    const p = plain(s);
    const at = p.indexOf(name);
    if (at < 0) continue;
    const after = p.slice(at);
    let what = null;
    const place = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)[- ]place/.exec(after);
    if (/pit ?lane/.test(p)) what = 'Pit lane start';
    else if (/back of the grid|rear of the grid/.test(p)) what = 'Back of the grid';
    else if (place) what = `${WORDS[place[1]] || place[1]}-place grid penalty`;
    else if (/disqualif/.test(p)) what = 'Disqualified from qualifying';
    else if (/no time|did not set a time|failed to set/.test(p)) what = 'No qualifying time';
    let why = null;
    if (/\b(ice|pu|power unit|engine|turbo|mgu|energy store|control electronics|exhaust)\b|pu components/.test(p)) why = 'new power unit parts';
    else if (/gearbox/.test(p)) why = 'new gearbox';
    else if (/imped/.test(p)) why = 'impeding in qualifying';
    else if (/parc ferm/.test(p)) why = 'changes under parc fermé';
    else if (/collision|causing/.test(p)) why = 'causing a collision';
    else if (/yellow|red flag/.test(p)) why = 'flag infringement';
    else if (/track limits/.test(p)) why = 'track limits';
    else { const m = /\b(?:for|after) ([^.,;]{4,60})/.exec(s); if (m) why = m[1].trim(); }
    return { what, why, text: s.trim() };
  }
  return null;
}

/** Hourly forecast at the start time: temperature, rain chance and amount, wind, cloud. */
async function startWeather(lat, lon, startIso) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const t = Date.parse(startIso);
  if (!t || t - Date.now() > 15 * 86400e3 || Date.now() - t > 6 * 3600e3) return null;
  const day = new Date(t).toISOString().slice(0, 10);
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,cloud_cover,weather_code&start_date=${day}&end_date=${day}&timezone=GMT`;
  const j = await json(u);
  const h = j.hourly || {};
  const times = (h.time || []).map((x) => Date.parse(`${x}:00Z`));
  if (!times.length) return null;
  let i = 0;
  for (let k = 0; k < times.length; k++) if (Math.abs(times[k] - t) < Math.abs(times[i] - t)) i = k;
  const at = (arr, k) => (Array.isArray(arr) && k >= 0 && k < arr.length ? arr[k] : null);
  return {
    temp: at(h.temperature_2m, i), rainChance: at(h.precipitation_probability, i), rain: at(h.precipitation, i),
    wind: at(h.wind_speed_10m, i), cloud: at(h.cloud_cover, i), code: at(h.weather_code, i),
    // The next two hours too: rain later in the race matters as much as at the start.
    later: [1, 2].map((d) => ({ rainChance: at(h.precipitation_probability, i + d), rain: at(h.precipitation, i + d) })),
  };
}

let cache = { at: 0, data: null };
let meetingsCache = { at: 0, year: null, list: [] };

/** The meeting under way, or the next one (this season, then next season). Cached 6 h. */
async function nextMeeting(now) {
  const year = new Date(now).getUTCFullYear();
  for (const y of [year, year + 1]) {
    if (meetingsCache.year !== y || Date.now() - meetingsCache.at > 6 * 3600e3) {
      const list = await json(`https://api.openf1.org/v1/meetings?year=${y}`).catch(() => []);
      meetingsCache = { at: Date.now(), year: y, list: list.sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start)) };
    }
    const m = meetingsCache.list.find((x) => !x.is_cancelled && Date.parse(x.date_end) > now);
    if (m) return m;
  }
  return null;
}

/** Everything for the between-sessions screen. `schedule` is the season schedule (with circuit lat/lon). */
export async function nextUp(schedule, { force = false, state = null } = {}) {
  // Keep a good answer 4 minutes; one with errors only 30 s, so it heals quickly.
  if (!force && cache.data && Date.now() - cache.at < (cache.data.errors.length ? 30000 : 4 * 60000)) return cache.data;
  const now = Date.now();
  const out = { generated: now, next: null, meeting: null, grid: null, weather: null, errors: [] };

  let sessions = [], meeting = null;
  try {
    // This weekend, or the next one: OpenF1 lists the whole season's meetings and sessions in advance.
    meeting = await nextMeeting(now);
    if (meeting) {
      sessions = await json(`https://api.openf1.org/v1/sessions?meeting_key=${meeting.meeting_key}`);
      sessions.sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
    }
  } catch (e) { out.errors.push(`sessions: ${e.message}`); }

  // The next session that hasn't finished: from this weekend if there is one, else the season schedule.
  const nextS = sessions.find((s) => Date.parse(s.date_end) > now && !s.is_cancelled);
  if (nextS && meeting) {
    out.meeting = {
      key: meeting.meeting_key, name: meeting.meeting_name, circuit: meeting.circuit_short_name, circuitKey: meeting.circuit_key,
      country: meeting.country_name, countryCode: meeting.country_code, year: meeting.year, gmtOffset: meeting.gmt_offset,
    };
    out.next = { name: nextS.session_name, type: nextS.session_type, start: nextS.date_start, end: nextS.date_end, key: nextS.session_key };
  } else {
    const s = (schedule?.sessions || []).find((x) => Date.parse(x.start) > now - 2 * 3600e3);
    if (s) out.next = { name: s.name, type: s.name, start: s.start, race: s.race };
    if (s) out.meeting = { name: s.race };
  }

  // Before a race or sprint: the grid.
  if (nextS && /^(Race|Sprint)$/.test(nextS.session_name)) {
    const sprint = nextS.session_name === 'Sprint';
    const decider = sessions.filter((s) => Date.parse(s.date_start) < Date.parse(nextS.date_start)
      && (sprint ? /sprint (qualifying|shootout)/i.test(s.session_name) : s.session_name === 'Qualifying')).at(-1);
    if (decider) {
      const k = decider.session_key;
      const f1p = f1GridPage(meeting, sprint).catch((e) => { out.errors.push(`f1.com: ${e.message}`); return { rows: [], note: '' }; });
      const grid = await json(`https://api.openf1.org/v1/starting_grid?session_key=${k}`).catch((e) => { out.errors.push(`grid: ${e.message}`); return []; });
      let result = await json(`https://api.openf1.org/v1/session_result?session_key=${k}`).catch((e) => { out.errors.push(`result: ${e.message}`); return []; });
      const drivers = await json(`https://api.openf1.org/v1/drivers?session_key=${k}`).catch(() => []);
      const f1 = await f1p;
      // No qualifying result from OpenF1? The live feed's own final classification will do.
      const info = state?.SessionInfo;
      if (!result.length && info?.Name === decider.session_name && String(info?.Meeting?.Key) === String(meeting.meeting_key)) {
        result = Object.entries(state.TimingData?.Lines || {}).filter(([, l]) => Number(l?.Position))
          .map(([num, l]) => ({ driver_number: Number(num), position: Number(l.Position) }));
      }
      const quali = new Map(result.filter((r) => r.position).map((r) => [String(r.driver_number), r]));
      const byNum = new Map(drivers.map((d) => [String(d.driver_number), d]));
      // Official grid: OpenF1, else formula1.com's table; else qualifying order (provisional).
      let rows = grid.filter((g) => g.position).sort((a, b) => a.position - b.position).map((g) => ({ pos: g.position, num: String(g.driver_number) }));
      let status = 'official', source = 'OpenF1';
      if (!rows.length && f1.rows.length) { rows = f1.rows.map((r) => ({ pos: r.pos, num: r.num })); source = 'formula1.com'; }
      if (!rows.length && quali.size) {
        rows = [...quali.values()].sort((a, b) => a.position - b.position).map((r) => ({ pos: r.position, num: String(r.driver_number) }));
        status = 'provisional'; source = 'qualifying result';
      }
      const totalQ = quali.size;
      out.grid = {
        for: nextS.session_name, from: decider.session_name, status, source, note: f1.note || '',
        rows: rows.map((r) => {
          const q = quali.get(r.num);
          const d = byNum.get(r.num) || {};
          const best = Array.isArray(q?.duration) ? q.duration.filter(Boolean).at(-1) : q?.duration;
          const row = {
            pos: r.pos, num: r.num, quali: q?.position ?? null, best: best || null,
            dns: !!q?.dns, dsq: !!q?.dsq,
            driver: { tla: d.name_acronym, first: d.first_name, last: d.last_name, team: d.team_name, colour: d.team_colour, headshot: d.headshot_url },
          };
          row.change = row.quali ? row.quali - r.pos : null; // + = gained places
          const why = reasonFor(f1.note, d.last_name);
          if (why) row.reason = why;
          else if (q?.dsq) row.reason = { what: 'Disqualified from qualifying', why: null };
          else if (row.change > 0) row.reason = { what: `Up ${row.change}`, why: 'penalties for cars ahead', inherited: true };
          else if (row.change < 0 && totalQ) row.reason = { what: `Down ${-row.change}`, why: null };
          return row;
        }),
      };
    }
  }

  // Weather for the start of the next session, at the circuit.
  try {
    const raceName = meeting?.meeting_name || out.next?.race;
    const date = (out.next?.start || '').slice(0, 10);
    const races = schedule?.races || [];
    const loc = races.find((r) => r.name === raceName) || races.find((r) => Math.abs(Date.parse(r.date) - Date.parse(date)) < 4 * 86400e3);
    if (loc && out.next?.start) {
      out.weather = await startWeather(loc.lat, loc.lon, out.next.start);
      out.where = { lat: loc.lat, lon: loc.lon, circuit: loc.circuit, locality: loc.locality };
    }
  } catch (e) { out.errors.push(`weather: ${e.message}`); }

  cache = { at: Date.now(), data: out };
  return out;
}

/** formula1.com's starting grid (or sprint grid) page for this meeting. */
async function f1GridPage(meeting, sprint) {
  if (!meeting?.meeting_key || !meeting?.year) return { rows: [], note: '' };
  const list = await fetch(`https://www.formula1.com/en/results/${meeting.year}/races`, { headers: BROWSER, signal: AbortSignal.timeout(15000) }).then((r) => r.text());
  const slug = new RegExp(`/results/${meeting.year}/races/${meeting.meeting_key}/([a-z0-9-]+)`).exec(list)?.[1];
  if (!slug) return { rows: [], note: '' };
  return parseGridPage(await page(`https://www.formula1.com/en/results/${meeting.year}/races/${meeting.meeting_key}/${slug}/${sprint ? 'sprint-grid' : 'starting-grid'}`));
}
