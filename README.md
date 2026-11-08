# Pit Wall

A personal second-screen dashboard for following Formula 1 sessions live on a laptop or phone while the race plays on your TV.

It connects to F1's live timing feed from your own computer and shows it as a web page you can open on the laptop and on any phone on the same Wi-Fi.

## What you get

**Free (no account needed)**

- Timing tower: positions, places gained, gap, interval, last and best laps, sector times, mini-sectors, tyre and tyre age, pit stops, speed trap
- Qualifying knockout zone and cut-off line, practice gaps to the fastest car
- Track map with estimated car positions (worked out from the timing loops)
- Battles: every car within 1.5 s of the car ahead, with closing/opening trend and an "attack range" flag under 1 s
- Moments: overtakes, fastest laps, pit stops, retirements, flags and penalties as they happen
- Race control messages, team radio (with playback), tyre strategy chart, weather, track status, lap counter / session clock
- **Driver focus**: click a driver anywhere (tower, map, battles, radio, moments, race control) to follow them. The Driver panel shows the gaps to the cars around them, last / best / ideal lap, tyres and stints, a lap-time chart, sectors, track-limit strikes, stewards' notes and their team radio. In qualifying it shows the live cut-off margin; in the race, where they would rejoin if they pitted now. Double-click a driver to open it, ↑ / ↓ steps through the field, Esc stops following. Optional pop-ups for that driver's pit stops, overtakes, fastest laps and radio.
- **Follow on map**: zooms the track map onto the driver you're following
- **Pace**: lap-time chart (and gap-to-leader chart in races) for your driver and the top five
- **Weather radar**: the last two hours of rain around the circuit, with distance rings and wind
- **Red flags**: the announced restart time with a countdown, plus rain / wet-track / low-grip notices from race control
- **Stays up**: if the internet drops, a bar says so and Pit Wall reconnects by itself within seconds of it coming back

**With an F1 TV subscription (Access plan is enough), switched on later**

- Live car telemetry: speed, throttle, brake, gear and RPM for any two drivers, with a rolling speed trace
- Real GPS positions on the track map
- Pit stop stationary times

You can preview the F1 TV panels any time with the "Demo + F1 TV preview" data source.

## Requirements

- Windows, macOS or Linux
- [Node.js](https://nodejs.org) 20 or newer
- It must run on your own home internet. F1 blocks requests from cloud servers.

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3000>. On Windows you can also double-click `start.cmd`.

The terminal prints a second address (like `http://192.168.1.20:3000`) for your phone. Settings (gear icon) shows it as a QR code too. Add it to your phone's home screen for a full-screen app.

| Command | What it does |
| --- | --- |
| `npm start` | Live F1 data. Every session is saved to `recordings/` automatically. |
| `npm run demo` | A simulated race at Interlagos, any time. |
| `npm run demo -- --f1tv` | Demo including the F1 TV-only data (telemetry, GPS map). |
| `npm run replay` | Replays the newest recording. Add a file name, `--speed 5`, `--skip 600` (seconds). |
| `npm run record` | Records the live feed without the dashboard. |

You can also switch between Live, Demo and Replay from the app without restarting.

## Replays

Every session Pit Wall shows live is saved on the laptop. Press **Replays** in the top bar (or "Watch a replay" when nothing is live) to pick one. A replay starts a minute before the scheduled start, so a race shows the formation lap.

While it plays, the bar at the bottom works like a video player: play / pause (or the space bar), back or forward 30 s, speed 1× to 30×, and a timeline with the starts, red flags, safety cars and chequered flags marked. Click a mark to jump just before it. **Live** goes back to live timing. Starting a replay is done on the laptop; once one is playing, any screen can pause or skip it.

## Flags and the start

When the track status changes, a flag waves on screen and the screen edges light up in its colour (Layout → Flag changes: waving flag, screen glow only, or off). At the start of a race the five red lights come on and go out.

F1's free feed says nothing during the formation lap: the race only counts as started at lights out. Pit Wall shows a countdown to the scheduled start, then "Formation lap" (or "Extra formation lap", "Start delayed", "Start aborted" when race control says so), with the cars lined up on the grid on the track map.

## Matching the TV (delay)

Your TV or stream is behind real time, so the data arrives first. Use the **Delay** button in the top bar:

- Presets: cable/satellite is often 5–10 s, streams 30–60 s.
- **Quick sync**: pick a car, then press "Crossed the line now" the moment you see it cross the finish line on TV. Pit Wall works out the exact delay.

Each screen keeps its own delay, so the laptop and the phone can follow different streams.

## Make it yours

- **Layout** (top bar): presets (Pit wall, Race engineer, Timing focus, Map focus, Sofa), text size (Compact / Comfortable / Large), Dark or Paper (light) theme, accent colour, and which panels are shown.
- **Drag panel tabs** onto another panel's tab bar to group them, or onto an edge to split into a new row or column.
- **Drag the gaps** between panels to resize. Double-click a column gap to make the columns equal.
- **Columns** (timing tower): choose which columns to show. Columns auto-hide when the panel gets narrow, and rows stretch to fit every car.
- Click a driver to highlight them on the map and in telemetry. On a phone, tap a driver for a detail card.

Layouts are saved per device.

## Connecting F1 TV (later)

1. Subscribe to F1 TV (the Access plan is enough).
2. On the laptop, sign in at formula1.com in Chrome or Edge.
3. Press F12 → Application → Cookies → `https://www.formula1.com`, and copy the value of the `login-session` cookie.
4. In Pit Wall: Settings → F1 TV → paste → Save & connect.

The token lasts about 4 days, so repeat once per race weekend. It is stored only in `config.json` on your laptop (git-ignored) and only sent to F1. You can also set it with the `F1TV_TOKEN` environment variable.

## Configuration

Copy `config.example.json` to `config.json` to change defaults:

```json
{ "port": 3000, "defaultDelay": 0, "f1tvToken": "" }
```

## How it works

- `server/f1feed.js`: SignalR Core connection to `livetiming.formula1.com/signalrcore`, with reconnects and automatic re-subscribe when a new session starts.
- `server/timeline.js`: keeps 6 minutes of history so every screen can watch with its own delay.
- `server/simulator.js`: demo race that emits messages in F1's exact format.
- `public/`: the dashboard (plain ES modules, no build step). `public/css/theme.css` holds every colour, font and size.

## Good to know

- This uses F1's unofficial live timing feed. F1 changes it without notice (car data moved behind F1 TV in 2025, and the archive of past sessions was locked in October 2026), so things may occasionally need fixing.
- For personal use on your own machine only. Don't host it publicly.
- Unofficial and not associated with Formula 1. Circuit outlines come from MultiViewer's public API. Schedule from the Jolpica API. Fonts are under the SIL Open Font License (see `public/fonts/LICENSES.txt`).
