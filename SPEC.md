# X-Ray Accessibility Camera — Build Spec (HackUMass XIV)

You are building a mobile web app for HackUMass XIV. Final submission is **Sunday 10:00 AM**; judging (science-fair style, ~3 min per judge) is **Sunday 12:30 PM in the ILC**. Optimize for a demo that works reliably indoors at the ILC, not for production completeness. Build in the milestone order below and keep the app working after every milestone.

Working name: **Wayfinder** (rename freely; the domain should match).

Track progress in `PROGRESS.md` so we can resume after you reach your limit.

Implement and ONLY write code until all code is written, then AFTER you may test and end-to-end test. 

---

## 1. What the product does

A phone app for **blind and low-vision people**. Everything is designed for them first: voice and sound are the primary interface, and the visuals are high-contrast and large for low-vision users. It combines:

1. **Voice agent (Gemini Live).** The user talks naturally. The agent sees through the phone camera and answers "what's in front of me?", finds things ("nearest bench", "nearest trash can", "where's the Computer Science Labs?"), offers directions, and narrates turn-by-turn walking directions.
2. **Bearing guidance.** Once a route is active, the app knows which way the user should face. As the phone turns away from the correct direction, feedback gets stronger: vibration on Android, plus a ticking sound panned toward the correct side on every phone (iOS Safari has no vibration API).
3. **X-ray mode.** The camera turns off and the screen shows a simplified 3D wireframe of the surroundings built from OpenStreetMap: the building you're in, nearby buildings, sidewalks, and small features (benches, trash cans, bike racks, entrances) snapped to the sidewalk they belong to. The view follows the phone's orientation, so you can "see through" walls to what's outside. The active route and the target appear as a glowing path and a beacon.
4. **Community accessibility reports (MongoDB Atlas).** OpenStreetMap knows where sidewalks are, but not that one is blocked by construction today, that an elevator is out, or which door has an automatic opener. Users can report these by voice ("there's a construction fence here"), or Gemini can offer to report what it sees in the camera. Reports are stored in Atlas with location, show up in x-ray and on the minimap, and are announced to other users who come near them or whose route passes them. Temporary reports expire automatically.

Prizes targeted (one [HACKUMASS] category on Devpost; sponsor prizes are opt-in and don't count toward the limit):
- [HACKUMASS] category: **Best Accessibility Hack**.
- Sponsor: **Best Use of Gemini API**, **Best Use of MongoDB Atlas**, **Best Use of Vultr**, **Best Domain Name from GoDaddy Registry**.
- Every project is automatically considered for Grand / 2nd / 3rd.

---

## 2. Stack decisions (final)

| Layer | Choice | Why |
|---|---|---|
| App type | **Mobile web app (PWA)**, not React Native | Gemini Live voice + video streams from the browser directly; one URL on our domain anyone can open; no app-store build. Only gap is iOS vibration, covered by sound. |
| Frontend | **Vite + React + TypeScript** | Fast to scaffold, hot reload on phone over LAN. |
| 3D | **three.js** via **@react-three/fiber** + **@react-three/drei** | Fast iteration for the x-ray scene. Write our own device-orientation camera control (three removed `DeviceOrientationControls`). |
| 2D map (normal mode / debug) | **MapLibre GL JS** with OSM raster tiles | Shows route, position, features; also the dev simulator surface. |
| State | **Zustand** | Shared store for position, heading, route, mode. |
| Voice/vision AI | **Gemini Live API** with **`gemini-3.8-live`**, client-to-server WebSocket via **`@google/genai`**, authenticated with **ephemeral tokens** | Lowest latency; backend never proxies audio/video. |
| Routing | **Public FOSSGIS OSRM server, foot profile** (`https://routing.openstreetmap.de/routed-foot`), called **directly from the browser** (it allows cross-origin requests, as openstreetmap.org itself uses it). No self-hosted OSRM. | Free, OSM-native, returns step maneuvers. Must follow the FOSSGIS usage policy: at most 1 request per second, no availability guarantee, base URL configurable rather than hardcoded. |
| Turn instructions | **osrm-text-instructions** | OSRM returns maneuver types, not sentences; this converts them to English. |
| Database | **MongoDB Atlas** (free M0 cluster), accessed from the Node backend with the official **`mongodb` driver** (one shared client for the process). In Atlas Network Access, allow only the Vultr server's IP plus team laptops for development. | Community accessibility reports, live and shared between users. Geospatial `2dsphere` queries, TTL expiry, optional Vector Search. |
| Map data | **Prebuilt campus data pack** (static JSON) generated once from **Overpass API** | No live Overpass calls during the demo (rate limits, latency). |
| Backend + hosting | **One Vultr Cloud Compute instance** (Ubuntu 24.04 LTS, 1 vCPU / 2 GB RAM, closest US East region) running **Docker Compose** with two containers: **Caddy** (automatic HTTPS, serves the built Vite app, reverse-proxies `/api`) and the **Node.js + Hono** API (TypeScript). Paid for with the MLH Vultr gift code, so $0 out of pocket. | One box, no vendor lock-in, plain Node so the MongoDB driver and Gemini SDK just work. Caches Nominatim responses in memory (an LRU map is enough). |
| Domain | Custom domain registered via **GoDaddy Registry**; point an `A` record (and `www`) at the Vultr server's IP. Caddy gets a Let's Encrypt certificate automatically once DNS resolves. | Camera, mic, geolocation and orientation sensors all require HTTPS. |

### Frontend / backend split

**Backend (tiny, stateless, `/api/*`):**
- `POST /api/token` → creates a Gemini Live ephemeral token (single use, ~30 min expiry, locked to our model + config + system instruction) and returns `{ token, model }`. API key lives only in the server's `.env` file (`GEMINI_API_KEY`, never committed; `.env.example` lists the variable names). Create the token with `@google/genai`'s `authTokens.create` on the server.
- `GET /api/geocode?q=...` → Nominatim fallback search bounded to the Amherst area, with a proper User-Agent and ≤1 req/s; cached.
- `GET /api/reports?lon=&lat=&radius=` → active reports near a point (`$geoNear`).
- `POST /api/reports/along-route` with a GeoJSON LineString → reports within 15 m of the route (`$geoWithin` on a buffered polygon, or `$geoIntersects`/`$near` per segment).
- `POST /api/reports` → create a report; `POST /api/reports/:id/confirm` and `/:id/resolve` → "still there" / "it's gone" votes.
- Connection string lives in `.env` (`MONGODB_URI`).

**Frontend (everything else):** sensors, location fusion, Gemini session, tool execution, bearing feedback, x-ray rendering, campus data pack, UI.

Gemini **tool calls are executed on the client** (they need the live position, heading, route and data pack), and results are sent back over the Live session.

---

### Vultr setup (M0, about 45 minutes)

1. Create a Vultr account through MLH's link and apply the gift code from the opening ceremony (or from an MLH coach) under Billing. Don't add a card, so nothing can be charged once the credit runs out.
2. Deploy a Cloud Compute instance: Ubuntu 24.04, US East region, 2 GB RAM. Add your SSH key. Install Docker + Compose.
3. Firewall: allow 22, 80, 443 only. The API stays on the internal Docker network behind Caddy.
4. DNS: `A` record for the domain → instance IP. Wait for it to resolve, then `docker compose up -d`; Caddy fetches the certificate.
5. Add the instance IP to Atlas Network Access.
6. After judging: take a snapshot if you want to keep it, then destroy the instance.

---

## 3. Repo layout

```
/
  server/                   # Node.js + Hono API (TypeScript)
    index.ts                # mounts /api/* routes
    token.ts
    route.ts
    geocode.ts
    reports.ts
    db.ts                   # one shared MongoClient
    Dockerfile
  Caddyfile                 # yourdomain { root * /srv/dist; file_server; try_files {path} /index.html; reverse_proxy /api/* api:8787 }
  docker-compose.yml        # caddy + api, restart: unless-stopped
  deploy.sh                 # ssh to server: git pull, build frontend, docker compose up -d --build
  .env.example
  scripts/
    build-campus-pack.ts    # Overpass → public/data/campus.json
    seed-atlas.ts           # creates indexes, seeds a few demo reports
  public/
    data/campus.json        # generated, committed
  src/
    main.tsx
    app/                    # screens: Start, Camera, XRay, DevSim
    store.ts                # Zustand
    geo/                    # ENU conversion, bearing, snapping, point-in-polygon
    sensors/                # permissions, heading, motion/steps, geolocation
    location/               # fusion filter, PDR, building constraints
    nav/                    # OSRM client, route progress, instructions
    feedback/               # audio ticks, vibration, deadband logic
    gemini/                 # live session, audio in/out worklets, video frames, tools
    xray/                   # three.js scene, geometry builders, labels
    data/                   # campus pack loader, gazetteer search
  SPEC.md
```

---

## 4. Campus data pack (`scripts/build-campus-pack.ts`)

Run once, commit the output. Bounding box: UMass Amherst campus plus a margin. Start with roughly **lat 42.380–42.400, lon −72.540 to −72.510** and adjust so it covers the whole campus and downtown edge.

Overpass query should fetch:
- `building=*` ways/relations with `name`, `building:levels`, `height`
- Walkable ways: `highway=footway|path|pedestrian|steps|service|residential|living_street|tertiary|secondary`, `footway=sidewalk|crossing`
- Point features: `amenity=bench|waste_basket|bicycle_parking|drinking_water|toilets|bus_station`, `highway=bus_stop`, `leisure=picnic_table`, `entrance=*`
- Optional: `natural=tree` (cap the count; skip if too heavy)

Output format (plain JSON, small enough to ship to the phone — aim for under ~3 MB):

```ts
type CampusPack = {
  origin: { lat: number; lon: number };   // ENU origin, center of bbox
  buildings: { id: string; name?: string; altNames?: string[]; heightM: number; outer: [lon,lat][]; holes?: [lon,lat][][] }[];
  ways: { id: string; kind: 'footway'|'sidewalk'|'path'|'steps'|'road'|'crossing'; coords: [lon,lat][] }[];
  features: { id: string; kind: 'bench'|'trash'|'bike_parking'|'water'|'toilets'|'bus_stop'|'entrance'|'picnic_table'|'tree'; lon: number; lat: number; name?: string; snapped?: { lon: number; lat: number; wayId: string } }[];
  gazetteer: { name: string; aliases: string[]; lon: number; lat: number; kind: string; buildingId?: string }[];
};
```

Build-time processing:
- **Height:** `height` tag → else `building:levels × 3.2 m` → else 8 m.
- **Snapping:** for each point feature not already on a way, project it onto the nearest `sidewalk/footway/path` segment within 12 m. Store the snapped point, offset 1.2 m to the side the original point was on, so benches sit beside the path, not on it. If nothing is within 12 m, keep the original point.
- **Gazetteer:** every named building and named feature, plus a **hand-maintained alias table** for UMass names people actually say. Verify each against the OSM names in the pack:
  - "CS Labs", "Computer Science Labs", "CSL", "Computer Science Laboratory" → Computer Science Laboratories building
  - "LGRT", "Lederle" → Lederle Graduate Research Tower
  - "ILC" → Integrative Learning Center
  - "CICS building", "Manning" → the CICS building
  - Add dining commons, library ("Du Bois", "the tower"), Campus Center, Student Union, Rec Center, Mullins.

---

## 5. Geometry basics (`src/geo`)

- Work in local **ENU meters** around `pack.origin` (equirectangular approximation is fine at campus scale: `x = (lon−lon0)·cos(lat0)·111320`, `y = (lat−lat0)·110540`).
- `bearing(from, to)` in degrees clockwise from true north.
- `angleDiff(a, b)` → signed difference in −180…180.
- Point-in-polygon for "which building am I in".
- Point-to-segment projection for snapping and route progress.

---

## 6. Problem 1: location inside buildings

GPS indoors is often 20–60 m off or stale. Browsers can't access Wi-Fi RTT or BLE beacons (Web Bluetooth isn't on iOS), so we fuse what the web *can* access:

**Sources:**
1. **GPS** (`watchPosition`, high accuracy). Use a fix only when `accuracy ≤ 25 m`. Outdoors this is the main source.
2. **Pedestrian dead reckoning (PDR)** between fixes. Detect steps from `DeviceMotionEvent` acceleration magnitude: low-pass filter, peak detection with a minimum interval of ~300 ms and a magnitude threshold, calibrated on a team member. Each step moves the estimate ~0.7 m along the current smoothed heading.
3. **Constraints.** If the estimate leaves the current building polygon through a wall far from any entrance, clamp it back inside; if the user is clearly outdoors and walking along a path, gently pull the estimate onto the nearest walkable way (map matching, weight ~0.3).

**Fusion:** a simple 2D Kalman-style filter in ENU with one uncertainty value σ (meters):
- PDR step: position += step vector; σ += 0.15 m per step.
- GPS measurement with accuracy r: gain k = σ² / (σ² + r²); position += k·(meas − position); σ = sqrt((1−k)·σ²).
- Show σ as a translucent circle on the map and in x-ray.

**Indoor status.** "Indoors" = estimate inside a building polygon OR GPS accuracy > 25 m for more than 10 s. When indoors, x-ray highlights the containing building's wireframe around the user.

---

## 7. Heading and bearing feedback

**Heading** (`src/sensors/heading.ts`):
- iOS: `DeviceOrientationEvent.requestPermission()` on the Start tap; use `event.webkitCompassHeading`, which is already a compass heading.
- Android: listen to `deviceorientationabsolute`; heading = `(360 − alpha) mod 360`.
- Both: correct for `screen.orientation.angle` (lock the app to portrait if possible). Smooth with a **circular** low-pass filter (average unit vectors, not degrees). Expose the raw quaternion separately for the x-ray camera.

**Target bearing:**
- With a route: the bearing to a "carrot" point ~12 m ahead along the route polyline from the user's projected position (not the final destination).
- Without a route but with a target (e.g. "point me at the nearest bench"): bearing straight to the target.

**Feedback** (`src/feedback`):
- error = |angleDiff(heading, targetBearing)|.
- Deadband ±20° (left only past ±24°): silent, with a soft confirmation chime when entering the deadband.
- 20–90°: tick rate rises from 2 Hz to 8 Hz with error, and stays at 8 Hz beyond 90°. The tick is a short Web Audio oscillator blip, **stereo-panned toward the side the user should turn** (pan = sign(diff) × min(1, error/90)), with pitch rising slightly as error grows.
- Android: `navigator.vibrate` pulses in sync with ticks; pulse length grows with error.
- iOS: optionally fire the hidden `<input type="checkbox" switch>` haptic trick on each tick (a short tap only); feature-flag it, off by default.
- Duck tick volume while Gemini is speaking.

---

## 7b. Community accessibility reports (MongoDB Atlas)

This is the data layer the app is missing without a database: OSM is a slow-changing map, while blind users mostly get hurt by things that changed today.

**Collection `reports`:**
```ts
{
  _id, kind: 'construction'|'blocked_sidewalk'|'broken_elevator'|'wet_floor'|'obstacle'|'auto_door'|'ramp'|'curb_cut'|'stairs_only'|'other',
  location: { type: 'Point', coordinates: [lon, lat] },
  building?: string, floor?: number,
  description: string,            // short, written by Gemini from the user's words / camera
  source: 'voice'|'camera'|'manual',
  permanent: boolean,             // auto_door, ramp, curb_cut, stairs_only = true
  confirmations: number, resolutions: number,
  createdAt: Date, lastConfirmedAt: Date,
  expiresAt?: Date                // temporary kinds only
}
```
Indexes: `2dsphere` on `location`; **TTL** on `expiresAt` (`expireAfterSeconds: 0`), so temporary hazards disappear on their own (default 48 h, extended 24 h on each confirmation).


**Behavior:**
- **Reporting:** user says "report a blocked sidewalk here", or Gemini sees one and asks "Do you want me to mark this for others?". The `report_hazard` tool posts it with the current position.
- **Nearby warnings:** the client polls `/api/reports` every 10 s within 60 m. The first time it comes within 15 m of a report, it injects a warning into the Gemini session ("Heads up: construction fence reported 10 meters ahead, on your right").
- **Route check:** when a route starts, call `/along-route`. If a blocking report (construction, blocked sidewalk) is on it, request OSRM `alternatives=true` and pick the alternative that avoids it; tell the user why.
- **Voting:** near a report, the agent can ask "Is the fence still there?" → confirm or resolve. Three resolutions delete a temporary report.
- **Stretch: Atlas Vector Search.** Store Gemini embeddings of report descriptions and of place descriptions, to answer fuzzy questions like "somewhere quiet to sit indoors near here" with `$vectorSearch` plus a geo filter. Only if everything else is done.

Seed the cluster (`scripts/seed-atlas.ts`) with 3–4 realistic reports around the ILC so the demo works even if nobody has reported anything yet.

---

## 8. Navigation (`src/nav`)

- `getRoute(from, to)` calls FOSSGIS from the browser and stores the geometry and steps:
  ```ts
  const OSRM_BASE = import.meta.env.VITE_OSRM_BASE ?? "https://routing.openstreetmap.de/routed-foot";

  // The /routed-foot/ path selects the foot profile; the "driving" segment is ignored by this server
  // (openstreetmap.org sends the same). Keep it as-is.
  const url = `${OSRM_BASE}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}`
    + `?overview=full&geometries=geojson&steps=true&alternatives=true`;
  const res = await fetch(url);           // plain fetch: no copied headers, referrer or hints
  ```
  - `overview=full&geometries=geojson` is required: the route line drives the bearing "carrot", route progress, the minimap and the x-ray route tube. (`overview=false` returns no line.)
  - Don't send `hints`: they're opaque snapping tokens from someone else's earlier request and are only valid for the same data version.
  - Don't set `User-Agent`, `Referer` or `Sec-Fetch-*`: browsers send their own automatically, and the policy says normal browsers already comply. Never claim to be openstreetmap.org.
  - **Rate limit:** a client-side queue that allows at most one request per second; reroutes are debounced (≥ 8 s off-route, §8) and identical requests are served from an in-memory cache keyed by coordinates rounded to ~5 m.
  - On failure or timeout (8 s), say "Directions are unavailable right now" and fall back to bearing-only guidance (`point_to`) to the destination.
- Turn the steps into sentences with **osrm-text-instructions** ("Turn left onto Governors Drive").
- **Route progress:** project position onto the polyline; track the current step index. Trigger an announcement at 25 m before each maneuver and again at 8 m. Mark arrival within 10 m of the destination.
- **Reports on the route:** see §7b; warn before the user reaches them.
- **Off-route:** if more than 25 m from the polyline for more than 8 s, reroute automatically and announce "Rerouting".
- **Announcements:** send them into the Gemini session as text ("Navigation update: in 20 meters, turn left onto Governors Drive. Say this to the user briefly.") so one voice speaks everything. If the Live session is down, fall back to `speechSynthesis`.
- **Routing from indoors:** route from the nearest `entrance` node of the current building, and first guide the user to that entrance with the bearing beacon.

---

## 9. Problem 2: Gemini Live integration (`src/gemini`)

**Connection**
1. On Start, the client calls `POST /api/token` and gets `{ token, model }`.
2. The client creates `new GoogleGenAI({ apiKey: token })` and opens `ai.live.connect({ model, config, callbacks })`. Use the API version the ephemeral-token docs require, and model **`gemini-3.8-live`** (pass it as `models/gemini-3.8-live` where the REST token endpoint expects a full resource name).
3. Config: `responseModalities: [AUDIO]`, input and output audio transcription on (shown as captions for deaf and hard-of-hearing users and for judges), the `tools` below, `sessionResumption`, and `contextWindowCompression`. Check the Live API docs for session length limits with audio + video and rely on resumption to reconnect seamlessly. Mint a new token on reconnect.

**Audio**
- Mic: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })` → AudioWorklet → downsample to **16 kHz mono PCM16** → `sendRealtimeInput({ audio })` in ~100 ms chunks.
- Speaker: the model returns **24 kHz PCM16**. Queue chunks into an AudioWorklet or scheduled buffer playback. On interruption (user starts talking, `interrupted` event), flush the queue immediately.
- Recommend earbuds for the demo; switch to tap-to-talk as a fallback in a loud room.

**Video**
- Camera mode: grab a frame about once a second from the `<video>` element, downscale to ~768 px on the long side, encode as JPEG ~0.6 quality, `sendRealtimeInput({ video })`.
- X-ray mode: stop the camera and frames, and send a text note to the session ("Camera is off; user is in x-ray mode; rely on map data").

**System instruction (summary)**
- You are a calm, concise guide for blind and low-vision people on the UMass Amherst campus.
- Lead with what matters for safety (steps, doors, obstacles, people ahead), using clock-face directions ("bench at your 2 o'clock, about 5 meters").
- Never invent locations: use tools for anything about places, distances or directions.
- Before starting navigation, confirm the destination in one short question.
- Keep turns under ~2 sentences unless asked for more.
- Lock the system instruction into the ephemeral token server-side.

**Tools (executed client-side; return compact JSON)**

| Tool | Args | Does |
|---|---|---|
| `get_context` | — | Returns the position estimate + σ, indoor/outdoor, containing building, heading (compass words + degrees), active route summary. |
| `find_place` | `query: string` | Gazetteer fuzzy search (aliases first) → top 3 with distance and clock-face bearing; falls back to `/api/geocode`. |
| `find_nearby` | `kind: enum[bench,trash,bike_parking,water,toilets,bus_stop,entrance]`, `limit?` | Nearest features from the pack, with distance + clock-face bearing. |
| `start_navigation` | `place_id` or `lon,lat`, `label` | Fetches the FOSSGIS OSRM route, starts guidance + bearing feedback, returns the step list (first 5 steps as sentences + total distance/time). |
| `point_to` | `place_id` or `lon,lat` | Bearing-only guidance to a target (no route). |
| `stop_navigation` | — | Stops guidance. |
| `set_mode` | `mode: camera \| xray` | Switches the view. |
| `report_hazard` | `kind`, `description`, `permanent?` | Creates a report in Atlas at the current position (§7b). |
| `get_reports_nearby` | `radius_m?` | Active reports nearby, with distance + clock-face bearing. |
| `vote_report` | `report_id`, `still_there: boolean` | Confirm or resolve a report. |
| `describe_xray_view` | — | Lists what's in the x-ray field of view (±35° of heading, ≤80 m): buildings, features, the target. |

Handle `toolCall` messages by running the matching function and replying with `sendToolResponse({ functionResponses: [{ id, name, response }] })`. Handle `toolCallCancellation`.

---

## 10. X-ray mode (`src/xray`)

- **Scene in ENU meters,** y-up in three.js (map ENU x→x, y→−z), user at eye height 1.6 m.
- **Camera rotation** from the device-orientation quaternion (standard alpha/beta/gamma → quaternion conversion, including the screen-orientation and −90° about X adjustments). Correct yaw so the scene's north matches compass heading (on iOS use `webkitCompassHeading` to compute a yaw offset). Smooth with slerp.
- **Buildings:** extrude footprints to `heightM`. Render with `EdgesGeometry` lines (wireframe), faint translucent faces (opacity ~0.06). The containing building gets brighter edges and its interior floor outline. Hide back-faces that would clutter; cap rendering at 250 m.
- **Ground:** walkable ways as flat ribbons (1.5–2 m wide, slightly lifted to avoid z-fighting); roads darker; crossings striped.
- **Small features:** simple primitives on their **snapped** positions: bench = low box, trash = cylinder, bike rack = arc, entrance = door frame on the building wall, bus stop = post. Billboarded icon + text label within 40 m.
- **Community reports:** red or orange warning pyramids at report locations (green for helpful permanent ones like automatic doors and ramps), labeled, pulsing when on the active route.
- **Route + target:** glowing tube along the route polyline, and a vertical beam at the target and at the next maneuver.
- **Labels:** building names as billboard sprites within 150 m. Show distance in meters on the target.
- **Low-vision styling:** high contrast (yellow and cyan on black), thick lines, a large-text toggle, a "simplify" toggle (buildings + route + target only). Minimum 60 fps target; drop to features-in-view-only if slow.
- **Accuracy circle:** draw σ as a ground ring around the user.

---

## 11. Screens and UX

1. **Start:** one huge "Start" button (needed for iOS permission prompts). Requests, in one gesture chain: orientation + motion permission (iOS), camera + mic, geolocation, `AudioContext.resume()`, Screen Wake Lock. Explain each permission in one line and announce it with an `aria-live` region.
2. **Main screen = full-screen camera feed**, edge to edge.
   - **X-ray is the default view.** A "Camera view" switch in Settings swaps to the camera; double-tap and voice ("switch to camera") also work. The live hazard check (Gemma, every 3–10 s, in both views) switches to the camera while a hazard is ahead and back to x-ray once the path is clear, unless the user changed the view in the meantime.
   - **Minimap: top-right corner overlay** (about 30% of the width, rounded, semi-opaque border), heading-up, showing position, σ circle, route, features and reports. Tap to expand to full screen; tap again to shrink.
   - **Talk control:** hands-free is the default. Tap-to-talk (Settings, or say "stop listening"): one tap on the mic button opens the mic with a rising tone, it closes by itself when the guide answers or the user pauses (falling tone), and ~0.5 s of pre-roll keeps the first words. Tapping while the guide speaks cuts it off. Optional headset play/pause button.
   - **Captions strip** above the bottom dock showing live transcripts (large text, togglable).
   - **Status line** at the top-left: indoor/outdoor, location accuracy, target + distance.
   - Everything is reachable with VoiceOver/TalkBack, with a logical focus order, and state changes are announced via `aria-live`.
4. **Dev simulator (`?sim=1`)** — essential for building without walking around:
   - Click the map to set position; a slider or drag for heading; buttons to "walk" 1 step.
   - Fake GPS accuracy (good / indoor-bad), and replay of a recorded route.
   - Lets you test x-ray, bearing feedback and navigation on a laptop.

---

## 12. Milestones (in order; time budget assumes a 4-person team starting Saturday 9 AM)

| # | Done when | Owner suggestion | Target |
|---|---|---|---|
| M0 | Repo scaffolded; Vultr server up with Docker Compose; Caddy serving the custom domain over HTTPS; a test FOSSGIS route returns from the phone; Start screen grants all permissions on an iPhone and an Android phone | Infra | Sat 10:30 |
| M1 | Campus pack built and loaded; mini-map shows buildings, paths, snapped features; dev simulator works | Data | Sat 12:00 |
| M2 | Gemini Live voice works on the phone (talk ↔ answer, captions), then camera frames ("what's in front of me?") | AI | Sat 13:00 |
| M3 | Tools `get_context`, `find_place`, `find_nearby` work by voice ("nearest bench?") | AI + Data | Sat 15:00 |
| M4 | FOSSGIS OSRM route from the browser; `start_navigation`; bearing ticks + Android vibration; step announcements | Nav | Sat 17:00 |
| M4b | Atlas: cluster, indexes, seed script; `/api/reports`; `report_hazard` and nearby warnings by voice | Data | Sat 18:00 |
| M5 | X-ray v1: buildings wireframe + ground paths + features following phone orientation | 3D | Sat 19:00 |
| M6 | Location fusion: GPS gating + PDR + building constraints; accuracy circle; indoor detection | Nav | Sat 22:00 |
| M7 | X-ray v2: route tube, target beam, containing-building highlight, labels, low-vision styling | 3D | Sun 00:00 (initial submission) |
| M8 | Polish: rerouting, interruption handling, error states, the Devpost write-up, demo video, pitch | All | Sun 09:30 |

**Cut list (drop in this order if behind):** Vector Search → trees → report voting → rerouting → iOS haptic hack → x-ray labels. **Never cut:** voice agent, `find_nearby`, navigation with bearing sound, x-ray buildings, PDR (it's the only indoor source), creating + warning about one community report.

---

## 13. Demo script (3 minutes at the ILC table)

1. "Most navigation apps stop working the moment you walk indoors, and they assume you can see the screen." Hand the judge the phone + earbuds.
2. Before the judge arrives, get a good GPS fix just outside the ILC entrance, then walk to the table so dead reckoning carries the estimate inside. Show the accuracy circle on the minimap.
3. Judge asks: "What's in front of me?" → Gemini describes the scene from the camera.
4. "Where's the nearest bench?" → answer with distance + clock direction.
5. Switch to **x-ray**: the ILC's walls are drawn around you; benches outside appear through the wall, snapped to the sidewalk.
6. "Take me to the Computer Science Labs." → the agent confirms; the judge turns the phone and hears the ticks speed up and pan, then go quiet when facing the right exit; the agent reads the first instruction.
7. **Two-phone moment:** a teammate's phone, a few meters away, says "there's a construction fence here, report it". Within seconds the judge's phone warns about it, and it appears as a red marker in x-ray.
8. Close: the technical hard parts (indoor location fusion with GPS + dead reckoning + building constraints, compass smoothing, snapping OSM features, live tool-calling agent, shared geospatial reports in Atlas), and the users (blind and low-vision students; Disability Services as a partner).

---

## 14. Engineering rules

- TypeScript strict. Small modules, as laid out in §3. No secrets in the client bundle.
- Every sensor has a simulated source for `?sim=1`.
- Fail soft: if Gemini disconnects, show it, auto-resume, and keep navigation + ticks + `speechSynthesis` working.
- Test on real phones from M0 onward (iPhone Safari + Android Chrome) via the deployed HTTPS domain (run `deploy.sh` often), or a free HTTPS tunnel (ngrok or similar) to a laptop's Vite dev server for quick iteration.
- Log the AI coding tools used (MLH rule: list them in the submission).
- Before the first commit of each module, verify any API detail flagged "check" in this spec against current docs (Gemini Live API version and session limits; the FOSSGIS routing usage policy; Nominatim usage policy).