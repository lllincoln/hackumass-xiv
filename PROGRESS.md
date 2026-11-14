# Progress

Last updated: Sat Nov 14 2026, ~10:00. Deadline: submission Sun 10:00, judging Sun 12:30 (ILC).

## State

All code for M0–M8 is written. It typechecks, 26 unit tests pass, the production build works, and the whole flow runs end to end in the simulator (`/?sim=1`) in headless Chromium. Nothing has been run on a real phone, against the real Gemini Live API, or against Atlas yet: there is no `.env` with keys on this machine.

Nothing is committed yet.

## Verified

- `npm run typecheck`, `npm test` (geo, fusion, feedback, heading, step detector, gazetteer, route geometry), `npm run build`.
- API in memory mode: health, create / dedupe / near / along-route / confirm / resolve (3 resolutions delete), input validation, Nominatim geocode.
- API Docker image builds and serves; Caddyfile validates.
- Live FOSSGIS OSRM route ILC → CS Labs from the browser (623 m, 2 alternatives).
- Simulator run: Start → tools (`get_context`, `find_nearby`, `find_place`, `start_navigation`, `report_hazard`, `describe_xray_view`) → indoor exit-door phase → route progress and announcements → report warning → x-ray scene (buildings, containing-building highlight, ways, labels, route tube, beams) → minimap.

## Not verified (needs keys or hardware)

1. **Gemini Live** (`GEMINI_API_KEY`): token minting, voice in/out, captions, camera frames, tool calls, resumption. Written against the current docs:
   - Ephemeral tokens use API version **`v1beta`** (the spec's "check" item; `v1alpha` is outdated).
   - A locked token's setup replaces the client's, so the resumption handle is sent to `/api/token` and baked into the token.
   - App text goes in with `sendRealtimeInput({ text })`.
   - Audio+video sessions are limited to 2 minutes without compression; `contextWindowCompression` is on, and `goAway` triggers a reconnect with the handle.
2. **MongoDB Atlas** (`MONGODB_URI`): the `$geoNear` / `$geoWithin` / pipeline-update code paths have only run through the in-memory twin. Run `npm run seed`, then repeat the report tests.
3. **Real phones**: iOS permission chain, `webkitCompassHeading` yaw offset, step-detector threshold (calibrate `STEP_DEFAULTS.threshold` in `src/sensors/motion.ts` on a teammate), Android vibration, audio echo with and without earbuds.
4. **Vultr deploy**: `deploy.sh` and `docker compose up` on the server with a real domain.

## Known gaps

- **Campus pack is missing multipolygon buildings** (for example the Du Bois Library, so "the library" finds nothing). The first Overpass fetch dropped them; the parser is fixed, but every Overpass mirror has timed out since. Rerun `npm run pack -- --refresh` and check the printed alias table (the "Du Bois" line should match, and "Campus Center" should map to Murray D. Lincoln Campus Center). Commit the new `public/data/campus.json`.
- Seed report coordinates in `scripts/seed-atlas.ts` are estimates around the ILC. Check them on the minimap after seeding.
- OSRM routes through the Campus Center concourse; the building constraint can hold the estimate inside until the next good GPS fix. Fine outdoors, worth a look on the demo route.
- Stretch (Atlas Vector Search) is not built.

## Next steps, in order

1. Create `.env` from `.env.example`; start `npm run dev:api` + `npm run dev`; test voice on a laptop at `/?sim=1`.
2. Rebuild the pack (above).
3. Atlas: create the M0 cluster, allow IPs, `npm run seed`.
4. Vultr + domain: follow SPEC §2 "Vultr setup", then `./deploy.sh`.
5. Phone testing at the ILC; calibrate steps; rehearse the demo script (SPEC §13).
6. Fill in `DEVPOST.md` (team, domain, video link) and submit.

## Decisions that differ from or add to the spec

- `shared/` holds the system instruction, tool declarations and report types used by both the API and the client.
- The API falls back to an in-memory report store when `MONGODB_URI` is unset (dev only).
- Heading is the back camera's direction when the phone is upright (top edge when flat), computed from the orientation matrix. Plain `360 − alpha` flips by 180° past vertical.
- A new report within 8 m of an active one of the same kind confirms it instead of duplicating.
- Navigating to a building aims for its mapped entrance nearest the user.
- drei is used only for thick lines; labels are canvas sprites, so x-ray needs no font download.
- The Overpass response is cached in `scripts/.overpass-cache.json` (gitignored).

## AI tools used (MLH rule)

Claude Code (Anthropic) wrote the code. The app uses the Gemini Live API at runtime.
