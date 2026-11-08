# Pit Wall developer guide

How Pit Wall is put together, and how to change any part of it. The [README](../README.md) is for using the app; this file is for working on it.

- [1. The big picture](#1-the-big-picture)
- [2. Running it while you work](#2-running-it-while-you-work)
- [3. Where everything is](#3-where-everything-is)
- [4. How data flows](#4-how-data-flows)
- [5. F1's live timing feed: what to know](#5-f1s-live-timing-feed-what-to-know)
- [6. The server](#6-the-server)
- [7. The front end](#7-the-front-end)
- [8. Recipes: common changes](#8-recipes-common-changes)
- [9. Testing and debugging](#9-testing-and-debugging)
- [10. Outside services](#10-outside-services)
- [11. Conventions](#11-conventions)

---

## 1. The big picture

Pit Wall is a small Node.js server plus a web page. There is **no build step and no framework**: the server is plain Node (ES modules), and the page is plain HTML, CSS and JavaScript modules that the browser loads directly. Change a file, refresh the browser, and you see it (server files need a server restart).

```
 F1 live timing (SignalR)          OpenF1, formula1.com, Open-Meteo,
 or the demo simulator             RainViewer, MultiViewer, Jolpica
 or a saved recording                         │
          │                                   │  (fetched on demand, cached)
          ▼                                   ▼
 ┌──────────────────────── server/index.js ────────────────────────┐
 │ source (F1Feed | Simulator | Replayer)                          │
 │   └─▶ Timeline (state + history, so each screen can lag)        │
 │   └─▶ Recorder (live only, JSON lines in recordings/)           │
 │   └─▶ LapHistory (every lap of every car)                       │
 │ HTTP: page files + /api/*        WebSocket: /ws                 │
 └─────────────────────────────────────────────────────────────────┘
          │  full state, then small updates, delayed per screen
          ▼
 ┌──────────────────────── public/js/app.js ───────────────────────┐
 │ store.state (same merge rules as the server)                    │
 │ views: header, tower, map, driver, pace, radar, battles, ...    │
 │ layout engine: panels, tabs, presets, phone navigation          │
 └─────────────────────────────────────────────────────────────────┘
```

The laptop runs the server. Any device on the same Wi-Fi (laptop browser, phone, tablet) opens the page and gets its own copy of the data, with its own delay.

## 2. Running it while you work

Needs Node.js 20 or newer.

```bash
npm install
npm run demo
```

Open <http://localhost:3000>. The demo is a simulated 40-lap race at Interlagos (countdown, formation lap, lights out, a VSC, a safety car, pit stops, a penalty, team radio), so you can work on anything at any time of the week.

Useful flags (they combine):

| Command | What it does |
| --- | --- |
| `npm start` | Live F1 data. Records every live session to `recordings/`. |
| `npm run demo` | Simulated race. |
| `node server/index.js --demo --speed 6` | Demo at 6× speed (a race in ~15 minutes). |
| `node server/index.js --demo --f1tv` | Demo with the F1 TV-only data (car telemetry, GPS map). |
| `npm run replay` | Plays the newest recording. Add a file name, `--speed 5`, `--skip 600` (seconds into the recording). |
| `node server/index.js --port 3111 --no-record` | A second copy on another port that never records. Handy next to the one you are watching with. |
| `npm run record` | Records the live feed with no dashboard (`server/record.js`). |

Settings come from `config.json` (copy `config.example.json`), overridden by environment variables:

| Setting | `config.json` | Environment | Default |
| --- | --- | --- | --- |
| Port | `port` | `PORT` | 3000 |
| F1 TV token | `f1tvToken` | `F1TV_TOKEN` | none (free data) |
| Delay for new screens | `defaultDelay` | `DEFAULT_DELAY` | 0 |
| F1 hub address (testing) | | `F1_HUB_URL` | F1's real hub |

`config.json`, `recordings/` and `cache/` are git-ignored: they hold a personal token, saved sessions and downloaded files.

## 3. Where everything is

```
start.cmd                 Windows double-click launcher (installs on first run, opens the browser)
config.example.json       Template for config.json
docs/DEVELOPER.md         This file

server/
  index.js                The server: picks the data source, holds the timeline, serves files, /api/*, /ws
  f1feed.js               Connection to F1's live timing (SignalR): subscribe, decode, reconnect, watchdog
  simulator.js            The demo race (also produces fake F1 TV telemetry and GPS)
  demo/                   Demo data: drivers.json (grid, photos), track.json (Interlagos outline), radio.json
  replay.js               Plays a recording like a video: pause, speed, seek, key moments, list descriptions
  recorder.js             Writes the live feed to recordings/*.jsonl (one file per session, lock file)
  record.js               `npm run record`: recorder without the dashboard
  timeline.js             State + rolling history, so each screen can watch with its own delay
  weekend.js              "Up next": next session, starting grid after penalties, start forecast
  transcribe.js           Team radio -> text with a local Whisper model (queue, cache, model loading)
  config.js               Reads config.json and environment variables

public/
  index.html              Page skeleton: top bar, every panel's markup (parked until the layout places it), dialogs
  css/theme.css           Design tokens: every colour, font size and spacing (dark and paper themes)
  css/app.css             All other styles, in titled sections
  js/app.js               Start-up: the store, the WebSocket, the render loop, global shortcuts, layout popover
  js/merge.js             How feed updates are merged into the state (shared with the server)
  js/format.js            Shared helpers: lap time parsing, session phase, track status, start procedure, ...
  js/history.js           LapHistory: every lap of every car (shared with the server)
  js/tracker.js           Where each car is on track: estimated from timing loops, or real GPS with F1 TV
  js/penalties.js         Time penalties, drive-throughs and stop-go's from race control messages
  js/media.js             Driver photos, team logos, car images (F1's public images via /api/img)
  js/layout.js            Dock layout: columns, tab groups, drag and drop, presets, phone tabs, focus mode
  js/views/
    header.js             Top bar: event, lap / clock / countdowns, track status pill, weather, rain chip
    tower.js              Timing tower (columns, sectors, tyres, gaps, penalties, photos)
    nextup.js             "Up next" between sessions: countdown, forecast, starting grid and why it changed
    map.js                Track map: outline, cars, grid before the start, follow mode, marshal sectors
    driver.js             Driver panel: one followed driver in detail, pit rejoin estimate, quali cut-off
    pace.js               Lap time and gap charts
    radar.js              Weather radar with forecast frames and outlook
    battles.js            Close fights (cars within a second)
    moments.js            "What just happened" feed: passes, pits, fastest laps, flags, penalties, lights out
    racecontrol.js        Race control messages
    radio.js              Team radio player: voice filter, transcripts, the who's-talking pop-up with live captions
    strategy.js           Tyre stints per driver
    telemetry.js          Car telemetry (F1 TV only)
    sheet.js              Phone: driver detail sheet
    settings.js           Settings dialog: phone QR, data source, F1 TV token, version
    replay.js             Replay list and the player bar at the bottom
    flagshow.js           Waving flag, screen-edge glow, start lights
```

## 4. How data flows

### 4.1 Sources

`server/index.js` runs exactly one **source** at a time. All three are `EventEmitter`s with the same shape, so the rest of the server doesn't care which one is running:

| Method / event | Meaning |
| --- | --- |
| `start()`, `stop()` | Begin / end. |
| `'init' (state)` | A complete state. It replaces everything; a feed reconnect sends one too. |
| `'feed' (topic, data, ts)` | One update for one topic. `ts` is the feed's own timestamp. |
| `'status' ({ state, detail, ... })` | Connection state shown in the top bar and the warning bar. |
| `'skip' (entry, state)` | Replay only: messages passed over while jumping, so lap history can be rebuilt. |
| `'replay' (info)` | Replay only: position, speed, paused, key moments, for the player bar. |

`switchSource(mode, opts)` swaps the source without a restart (Settings, the Replays list and the player bar use it via `/api/mode`).

### 4.2 Merging (`public/js/merge.js`)

F1 sends a full object per topic first, then **partial patches**. `applyMessage(state, topic, data)` is the one function that applies them, on the server and in every browser, so both always agree:

- Objects are deep-merged.
- Arrays are patched with objects keyed by index: `{"Sectors": {"1": {"Value": "28.123"}}}` changes sector 2 only.
- `"_deleted": [keys]` removes entries.
- `CarData` and `Position` are replaced, not merged (each message is a fresh batch).
- The special topic `INIT` (`'__init'`) replaces the whole state.

### 4.3 Delay (`server/timeline.js`)

Each screen can hold the data back to match its TV. The `Timeline` keeps the current state, a log of recent messages and a snapshot every 5 seconds (up to `MAX_DELAY_S` = 300 s of history). For each WebSocket client the server sends `stateAt(now − delay)` once, then every 100 ms the messages that have become due for that client's delay.

### 4.4 WebSocket protocol (`/ws`)

Server → browser:

| `type` | Payload | When |
| --- | --- | --- |
| `hello` | `mode, status, maxDelay, serverNow, replay` | On connect and whenever the source changes. |
| `state` | `state, at, delay` | A full state (connect, delay change, replay jump). |
| `msgs` | `msgs: [[t, topic, data], ...]` | Updates now due for this screen. |
| `status` | `status` | Source / connection changes. |
| `replay` | `info` | Replay player changes. |
| `ping` | `serverNow, lastDataAt, mode` | Every 5 s (clock sync, "no data" warning). |
| `toast` | `text` | A one-off message for this screen. |
| `transcript` | `clip, entry` | A radio clip has been transcribed. |
| `transcriber` | `status` | Speech model status (loading, working, unavailable...). |

Browser → server: `{ type: 'delay', seconds }` and `{ type: 'sync', driver }` ("this car crossed the line on my TV now").

### 4.5 Time

Three clocks matter in the browser (`public/js/app.js`):

- `store.playNow()`: the moment on the server's timeline this screen is showing (server time minus this screen's delay; frozen while a replay is paused). Use it for animation and interpolation (the map, telemetry).
- `store.dataNow()`: the real-world time of what's on screen. Live, it equals `playNow()`. In a replay it's the time **inside the recording**. Use it for anything compared with F1 timestamps or the schedule: countdowns, "is this session over", formation lap.
- `Date.now()`: the wall clock. Only for things that really are about now (the "up next" countdown, toasts).

### 4.6 Recordings

`recordings/<date>_<meeting>_<session>.jsonl`, one JSON object per line:

```
{"t":<ms epoch>,"type":"init","data":{...full state...}}
{"t":<ms epoch>,"type":"feed","topic":"TimingData","data":{...},"ts":"<feed timestamp>"}
```

Only live data is recorded, never the demo or a replay. A lock file (`recordings/.recording.lock`) stops two running copies from writing the same session twice. These files are also the best test data you have: see [9](#9-testing-and-debugging).

## 5. F1's live timing feed: what to know

Hub: `https://livetiming.formula1.com/signalrcore`. `Subscribe` returns the full state of every topic; after that the hub sends `feed` messages with patches. Topics ending in `.z` are base64 raw-deflate JSON (`decodeZ` in `server/f1feed.js`).

- **Free topics** (no login): `Heartbeat, ExtrapolatedClock, TopThree, TimingStats, TimingAppData, WeatherData, TrackStatus, SessionStatus, DriverList, RaceControlMessages, SessionInfo, SessionData, LapCount, TimingData, TeamRadio, PitLaneTimeCollection, RcmSeries`.
- **F1 TV topics** (token): `CarData.z` (speed, rpm, gear, throttle, brake, DRS), `Position.z` (car X/Y/Z), `ChampionshipPrediction`, `PitStopSeries`.

Things that are not obvious and that the code depends on:

- **SessionStatus**: `Inactive` before the start; `Started`; `Aborted` = red flag; `Inactive` with `Started: "Started"` = stopped, waiting to restart; `Finished` (also at the end of Q1 and Q2), `Finalised`, `Ends`. `sessionPhase()` in `format.js` turns this into `pre | running | suspended | paused | finished`.
- **A race is `Inactive` through the formation lap** and becomes `Started` at lights out. `startProcedure()` uses the scheduled start (`SessionInfo.StartDate` + `GmtOffset`) and race control messages to tell countdown / formation lap / extra formation lap / start delayed / start aborted apart.
- **Between sessions the feed keeps serving the last session** (status `Ends`) and re-sends it on every reconnect. `sessionOver()` treats a finished session more than an hour past its scheduled end (`SessionInfo.EndDate`) as old, and the timing panel shows "Up next" instead.
- **TrackStatus.Status**: 1 clear, 2 yellow, 4 safety car, 5 red, 6 VSC, 7 VSC ending. `TRACK_STATUS` and `trackState()` in `format.js`.
- **Mini-sector segment status**: 2048 yellow (slower), 2049 green (personal best), 2051 purple (fastest), 2064 pit lane, 0 not yet passed. F1 **re-colours** segments after the fact (purple turns green when someone goes faster), so only a 0 → non-zero change means a car passed a timing loop (`EstimatedTracker` in `tracker.js`).
- **`NumberOfLaps` also ticks when a car leaves the garage** in qualifying; it is not always a line crossing.
- **Times** are strings: `"1:13.018"`, `"28.123"`, gaps like `"+1.234"`, `"LAP 23"` for the leader, `"1L"` for a lapped car. Use `parseLap()` and `gapSeconds()` (`history.js`).
- **Timestamps** in `RaceControlMessages` and friends often have no `Z`; treat them as UTC (`utcMs()` helpers).
- **`SessionInfo.StartDate` / `EndDate` are local track time.** Add `GmtOffset` to get UTC (`sessionStartUtc()`, `sessionEndUtc()`).
- **Team radio** clips are at `https://livetiming.formula1.com/static/<SessionInfo.Path><Capture.Path>`; the server proxies and caches them (`/api/radio`). F1's file names hold the local time the clip was recorded.
- F1 has **locked its archive** (`/static/<year>/Index.json` answers 401), so old sessions can't be downloaded; Pit Wall records its own.

## 6. The server

### 6.1 HTTP endpoints (`server/index.js`)

| Endpoint | What it returns |
| --- | --- |
| `GET /api/info` | Mode, status, version, phone address and QR code, whether this device may change settings. |
| `GET /api/circuit?key&year` | Circuit outline and pit-loss figures from MultiViewer (cached in `cache/circuits/`, falls back up to two years). |
| `GET /api/radio?path` | A team radio clip, proxied and cached. |
| `GET /api/img?id&t` | An F1 image (`t` = `face`, `logo` or `car`), resized by F1's image service and cached in `cache/img/`. |
| `POST /api/token` | Save or clear the F1 TV token (this laptop only). |
| `POST /api/mode` | Switch source: `{ mode: 'live' | 'demo' | 'replay', file?, speed?, skip?, f1tv? }` (this laptop only). |
| `GET /api/recordings` | Saved sessions with title, length and key moments. |
| `POST /api/replay` | Player control: `{ action: 'play' | 'pause' | 'speed' | 'seek' | 'jump', value? }` (any screen). |
| `GET /api/history` | Lap history snapshot for the charts. |
| `GET /api/transcripts?session` | Team radio transcripts for a session, and the speech model's status. |
| `GET /api/forecast?lat&lon` | 3-hour rain forecast on a 7×7 grid around the circuit (Open-Meteo). |
| `GET /api/radar` | RainViewer radar frame list. |
| `GET /api/nextup` | Next session, starting grid after penalties, start forecast (`server/weekend.js`). `?fresh` skips the cache. |
| `GET /api/schedule` | The season's sessions and circuits with coordinates (Jolpica). |

"This laptop only" means the request must come from `localhost` (`isLocal()`), so a phone on the Wi-Fi can't change your token or stop a live recording.

Everything else is served from `public/`.

### 6.2 Adding an endpoint

Add a branch in the request handler in `server/index.js` (they're plain `if (url.pathname === '/api/...')` checks) and reply with `sendJson(res, status, data)`. For outside services, follow the existing pattern: send a `user-agent`, set a timeout, cache the answer in memory (or in `cache/` for files), and return something sensible when the service is down. The page should never break because an outside service did.

### 6.3 Radio transcription (`server/transcribe.js`)

When a session state arrives or a new `TeamRadio` capture comes in, the server queues the clip (new live clips first, then the backlog newest first). One clip at a time: download (shared with `/api/radio` and its cache), decode the mp3 with `mpg123-decoder` (a fresh decoder per clip), average down to 16 kHz mono, run Whisper through `@huggingface/transformers` on the CPU with `return_timestamps`, drop things Whisper invents from noise ("Thank you.", "[music]"), save to `cache/transcripts.json` and broadcast `{ type: 'transcript', clip, entry }`. `entry` is `{ text, chunks: [{ t: [start, end], text }], secs, took, model }`. The model loads on first use and unloads after 20 idle minutes. `GET /api/transcripts?session=<SessionInfo.Path>` returns a session's saved transcripts and the model status.

Screens only show a transcript once the clip itself is in their (delayed) state, so the text never runs ahead of the TV. The pop-up's live caption spreads each chunk's words evenly across its start and end times (`#caption()` in `radio.js`).

Model choice (`transcribeModel`, `transcribeDtype` in `config.json`): `whisper-small.en` q8 takes about 5–6 s per clip on a laptop CPU and copes with engine noise much better than `whisper-base.en` (about 2 s per clip).

### 6.4 Connection handling (`server/f1feed.js`)

`F1Feed` reconnects with its own schedule (1, 2, 4, 8, 15 s), classifies network errors as `offline`, and forces a reconnect when nothing (not even a heartbeat) has arrived for 45 s. Its `status` tells the browser when the link went down, when it will retry and how long it was down; the yellow/red bar under the top bar is drawn from that.

## 7. The front end

### 7.1 The store (`public/js/app.js`)

One object, `store`, is passed to every view. The useful parts:

| Member | Use |
| --- | --- |
| `state` | The merged F1 state (same shape as the feed). Read only. |
| `status`, `connected`, `replay`, `nextup` | Source status, WebSocket state, replay info, "up next" data. |
| `playNow()`, `dataNow()` | See [4.5](#45-time). |
| `selected`, `select(num, opts)` | The driver being followed. `select` with `{ reveal: true }` also opens the Driver panel. |
| `delay`, `setDelay(s)`, `sync(num)` | This screen's delay. |
| `dirty()` | Ask every view to redraw on the next frame. |
| `toast(text, cls, onClick)` | A pop-up message (`cls`: `'ok'`, `'red'`, `'rain'`, `'driver'`). |
| `notify(panelId)` | Put a dot on a panel's tab when it has news and isn't visible. |
| `history`, `circuit`, `schedule`, `map` | Lap history, circuit data (pit loss), season schedule, the map view. |
| `flagShow(key)`, `lightsOut()` | The flag and start-light animations. |
| `alerts` | Whether the followed driver gets pop-ups. |

### 7.2 Views

A view is a class that takes `store` in its constructor and implements any of these:

| Hook | Called | Use it for |
| --- | --- | --- |
| `update()` | When something changed (at most every ~90 ms) | Redrawing from `store.state`. Compare with what you drew last time and skip when nothing changed. |
| `frame(now)` | Every animation frame (`now` = `playNow()`) | Smooth movement and ticking clocks. Keep it cheap. |
| `onMessage(t, topic, data, state)` | For every feed update, in order | Detecting events: "a car just pitted", "track status just changed". `update()` only sees the latest state, so anything about a change belongs here. |
| `reset(state, at)` | When a full state arrives | Clearing what `onMessage` built up. |

Register it in `app.js`: create it after the store and add it to the `views` array; if it has `onMessage`/`reset`, call them from `onMsgs()`/`onState()` like the others.

Full states also arrive on reconnects, delay changes and replay jumps. They are not events. The header compares `store.stateGen` (bumped on every full state) so it doesn't wave a flag or show a toast for them; do the same for anything that reacts to changes.

### 7.3 Panels and layout (`public/js/layout.js`)

- Each panel's markup is a `<section class="widget" id="w-<id>" data-w="<id>">` in `public/index.html`, optionally with a `<div class="w-tools">` for buttons shown in the panel's header. Sections start in `#parking` and the layout engine moves them into place.
- `WIDGETS` lists every panel: `id → { title, short, icon }`. `short` is used on phone tabs and preset thumbnails.
- `PRESETS` are whole layouts: columns (`w` = relative width) of groups (`h` = relative height) of tabs.
- The layout is saved per device in `localStorage.layout`. `#migrate()` adds panels that are new since the saved layout was made, so adding a panel never breaks someone's layout.
- Useful methods: `layout.reveal(id)` (bring a panel to the front), `layout.setFocus(id)` (single-panel view), `layout.show(id, on)`, `layout.placed(id)`, `layout.visible(id)`.
- Under 900 px wide the layout becomes one panel at a time with a bottom tab bar (`layout.mobile`).

### 7.4 Styling

- **All colours, fonts and sizes are tokens in `public/css/theme.css`.** Change a token and every panel follows. Dark is the default; `body[data-theme="paper"]` is the light theme. Data colours (purple/green times, flags, tyres, team colours) are separate from the greyscale interface on purpose.
- `body` carries the current choices as attributes: `data-theme`, `data-density` (`compact | comfortable | large`), `data-accent`, `data-track` (current flag: `green | yellow | sc | vsc | red | chequered | paused | none`) and `data-kind` (`race | quali | practice`). Style against these instead of adding classes from JavaScript.
- `public/css/app.css` is split into titled sections (`/* ===== map */` and so on). Keep new styles in the section they belong to, or add a new titled section at the end.
- Design rules the app follows: flat surfaces, hairline (1 px) rules, square-ish corners, one typeface (Inter, served locally), no decorative gradients. Motion is for things that happen (a position change, a flag, lights out), using the `--ease` and `--dur-*` tokens, and is turned off for `prefers-reduced-motion`.

### 7.5 Helpers worth knowing

- `format.js`: `esc()` (always escape text you put in HTML), `parseLap`, `fmtLap`, `fmtClock`, `sessionKind`, `sessionPhase`, `trackState`, `restartInfo`, `startProcedure`, `sessionOver`, `driverOrder`, `currentStint`, `stintList`, `teamColor`, `sessionLocalTime`.
- `history.js`: `store.history.of(num)` gives every lap of a car `{ lap, time, pb, purple, pit, comp, pos, gap }`.
- `penalties.js`: `penalties(state, history)` gives each car's owed time penalty, drive-through or stop-go.
- `media.js`: `avatar(driver)`, `headshot`, `teamLogo`, `carImage`, `img()`. Images that fail to load remove themselves.
- `tracker.js`: `EstimatedTracker` (positions from timing loops: `progress()`, `visible()`, `pace()`, `last()`) and `GpsTracker` (F1 TV positions).

### 7.6 Settings saved per device

All in `localStorage`: `layout, focus, mtab, towerCols, density, theme, accent, delay, selected, driverAlerts, flagAnim, mapFollow, paceMode, radarZoom, radioAuto, radioClean, teleA, teleB`. Clearing site data in the browser resets a device to defaults.

## 8. Recipes: common changes

### Add a panel

1. `public/index.html`: add `<section class="widget" id="w-mypanel" data-w="mypanel"><div class="mypanel" id="mypanel"></div></section>` inside `#parking`.
2. `public/js/layout.js`: add `mypanel: { title: 'My panel', short: 'Mine', icon: I('<svg path…>') }` to `WIDGETS`. Optionally add it to some `PRESETS`.
3. `public/js/views/mypanel.js`: a class with `constructor(store)` and `update()` that fills `#mypanel` from `store.state`.
4. `public/js/app.js`: import it, `const mine = new MyPanel(store);`, add `mine` to `views`.
5. `public/css/app.css`: a new titled section for its styles.

Existing layouts pick the new panel up automatically (see `#migrate()`).

### Add a timing tower column

In `public/js/views/tower.js`:

1. Add an entry to `COLUMNS`, in the position you want it: `id`, `label` (header text), `w` (its CSS grid width), `min` (pixels it needs), `prio` (higher = kept longer when the panel gets narrow), and optionally `off: true` (hidden until switched on), `race: true` (races only), `title` (tooltip).
2. Add its name to `LABELS`; that's what the **Columns** menu shows.
3. Add its cell to the row template in `#row()` at the same position as in `COLUMNS` (the row is a CSS grid built from the `w` values), and keep a reference to it in the object `#row()` returns.
4. Fill it in `update()` with `this.#set(row, 'myid', row.mycell, html, className)`. `#set` only touches the page when the value changed.
5. In `app.css`, add `.tower.hide-myid .c-myid { display: none; }` next to the other `hide-` rules, so it disappears when switched off or when space runs out.

The user's choice is saved per device in `towerCols`.

### React to something happening on track

Use `onMessage(t, topic, data, state)`: compare the incoming patch with what you remembered (see `moments.js`, which detects passes, pit stops, fastest laps, lights out and penalties). To show it in the Moments feed, add a case there with a `kind` and `cls` (style `.moment.<cls> .m-ico` in `app.css`).

### Change colours, fonts, sizes

Edit the tokens in `public/css/theme.css`. For the light theme, the `body[data-theme="paper"]` block. Text sizes per density are tokens too.

### Change or add a flag animation

`public/js/views/flagshow.js`: `FLAGS` maps a track-status key to a cloth (a colour token or `'chequered'`), optional printed text (`board`), how much it swings and for how long. The cloth is drawn strip by strip on a canvas in `ClothFlag.draw()`. `GLOW` sets the screen-edge colour per status. The header calls `store.flagShow(key)` when `trackState().key` changes.

### Use another outside data source

Add a server endpoint (see [6.2](#62-adding-an-endpoint)) rather than calling the service from the browser: one place to cache, no CORS problems, phones on the Wi-Fi get it too. `server/weekend.js` is a complete example (spaced requests for a rate-limited API, a fallback chain, errors reported in the response, shorter caching when something failed).

### Handle a new F1 topic

Add it to `FREE_TOPICS` or `AUTH_TOPICS` in `server/f1feed.js`. It then arrives in `store.state.<Topic>` and in every view's `onMessage`. If its messages are complete batches rather than patches, add it to `REPLACE_TOPICS` in `merge.js`.

### Rules that change between seasons

A few regulation numbers are written into the code. Search for them if the rules change:

- Qualifying part lengths: 18/15/12 min, sprint qualifying 12/10/8 min (`header.js`, `sessionLen`).
- How many cars go through in Q1/Q2 when F1 doesn't say (`tower.js`, knockout zone).
- How long a formation lap may take before it reads "Waiting for the start" (12 min, `startProcedure()` in `format.js`).
- When a finished session counts as old (60 min after its scheduled end, `sessionOver()`).

Drivers, teams, colours, photos, circuits and the calendar all come from live sources and need no changes.

## 9. Testing and debugging

There is no test framework; the app is tested by running it.

- **The demo** covers most of a race in 15 minutes at `--speed 6`, including the start sequence (countdown 20 s, formation lap, lights out at 50 s of demo time), VSC, safety car, pit stops, a 5 s penalty, track limits and radio.
- **Recordings are real fixtures.** `npm run replay -- <file> --speed 10 --skip 900`, or the Replays list and player bar, replay any saved session with exactly what F1 sent: red flags, rain, qualifying knock-outs, reconnects. Keep interesting ones.
- **Run a second copy** with `--port 3111 --no-record` to test a change while the main one keeps recording.
- **Syntax check** everything quickly: `for f in server/*.js public/js/*.js public/js/views/*.js; do node --check "$f"; done`.
- **Pure functions can be tried in Node directly**, since `format.js`, `merge.js`, `history.js` and `penalties.js` have no browser dependencies:
  ```bash
  node -e "import('./public/js/format.js').then(f => console.log(f.parseLap('1:13.018')))"
  ```
- **Fake hub**: `F1_HUB_URL` points the live feed somewhere else (for example a small SignalR test server) to simulate outages or odd messages.
- **In the browser**: the page has no build step, so the developer tools show the real source files. Errors in a view are caught per view and logged to the console (one broken view doesn't stop the others).
- **Phones**: open the phone address from Settings, or use the browser's device emulation (under 900 px wide switches to the phone layout).

## 10. Outside services

Everything is free and needs no account. If one disappears, only its own feature stops.

| Service | Used for | If it's down |
| --- | --- | --- |
| F1 live timing (`livetiming.formula1.com`) | All timing, radio clips | No live data; replays and demo still work. |
| MultiViewer (`api.multiviewer.app`) | Circuit outlines, pit-loss figures | Cached outlines keep working; new circuits show no map. |
| F1 media (`media.formula1.com`) | Driver photos, team logos, cars | No pictures (cached ones stay). |
| OpenF1 (`api.openf1.org`) | Up next: sessions, starting grid, qualifying result, drivers | Falls back to formula1.com's grid and the feed's own qualifying order. |
| formula1.com results pages | Penalty explanation under the grid (and the grid itself as a fallback) | The grid still shows; drivers read "Down 5" without a reason. |
| Open-Meteo | Rain forecast on the radar, forecast for the start | No forecast. |
| Hugging Face (first run only) | Downloading the Whisper speech model into `cache/models/` | Transcription waits until it can download; once downloaded it works offline. |
| RainViewer | Radar frames | No radar frames. |
| Esri (ArcGIS) | Grey base map under the radar | Radar without a base map. |
| Jolpica (Ergast) | Season schedule, circuit coordinates | No schedule-based countdown or weather location. |

## 11. Conventions

- **No build step, no framework, few dependencies**: `ws`, `@microsoft/signalr`, `qrcode`, plus `@huggingface/transformers` and `mpg123-decoder` for radio transcription (loaded only when needed; Pit Wall runs without them). Keep it that way unless there is a strong reason: anyone can open a file and change it.
- **Comments say why**, not what. The feed has many traps (section 5); when you work around one, write down what F1 does.
- **Escape everything** that comes from outside before it goes into HTML (`esc()`).
- **Fail soft.** An outside service, a broken image or one view's bug must never take the dashboard down.
- **Per-device settings** go in `localStorage`; the laptop's own settings go in `config.json`.
- **Git**: work on a branch (`feature/...`, `fix/...`, `docs/...`), commit with one-line messages, merge into `main` with `--no-ff`, push both. Bump `version` in `package.json` for anything users would notice; it shows in Settings → About and in the terminal on start.
