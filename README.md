# Wayfinder

A voice-first navigation camera for blind and low-vision people, built for HackUMass XIV. See `SPEC.md` for the full design and `PROGRESS.md` for status.

- **Voice agent** (Gemini Live): sees through the camera, finds places and features, starts navigation.
- **Bearing guidance**: ticks that speed up and pan toward the side to turn; vibration on Android.
- **X-ray mode**: a wireframe of buildings, paths and features from OpenStreetMap that follows the phone.
- **Community reports** (MongoDB Atlas): hazards and helpful features, shared live between users.

## Run locally

```bash
npm install
cp .env.example .env        # add GEMINI_API_KEY and MONGODB_URI
npm run pack                # once: Overpass → public/data/campus.json (commit the result)
npm run dev:api             # API on :8787
npm run dev                 # app on :5173, proxies /api
```

Open `http://localhost:5173/?sim=1` for the dev simulator (fake position, compass and steps; arrow keys turn and walk).

Without `MONGODB_URI` the API keeps reports in memory. Without `GEMINI_API_KEY` the voice guide is off, and navigation, ticks and spoken announcements (browser speech) still work.

Phones need HTTPS for the camera, mic, location and compass: use the deployed domain, a tunnel, or `HTTPS=1 npm run dev` (self-signed).

```bash
npm run typecheck
npm test
npm run seed                # Atlas indexes + demo reports around the ILC
```

## Deploy (Vultr)

On the server: clone to `/opt/wayfinder`, create `.env` there (with `DOMAIN=yourdomain`), point the domain's `A` record at the server. Then from a laptop:

```bash
DEPLOY_HOST=<server ip> ./deploy.sh
```

It pulls, builds the frontend in a Node container, and runs `docker compose up -d --build` (Caddy for HTTPS + static files, the Hono API behind `/api`).

## Data and services

- Map data © OpenStreetMap contributors (ODbL), via Overpass at build time.
- Routing: FOSSGIS OSRM foot profile, called from the browser at most once per second.
- Geocoding fallback: Nominatim through `/api/geocode`, cached, at most once per second.

## AI tools used

Built with Claude Code (Anthropic). The app itself uses the Gemini Live API.
