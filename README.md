# Wayfinder

Voice, spatial audio, and 3D navigation for blind and low-vision students at UMass Amherst. Built at HackUMass 2026.

Live app: **https://wayfinder.boston**

## Why we built this

Most navigation apps stop working the moment you walk near a building, and they assume you can see the screen. When we looked into how blind and low-vision students actually get around UMass, we realized the static map isn't the real problem. The map is fine until there is a construction fence blocking the sidewalk by Du Bois Library, an icy ramp, or a broken elevator, and nobody told them.

We also learned that most legally blind people still have some residual vision, but normal camera feeds and standard maps have way too much glare and clutter to be useful. Wayfinder turns a phone browser into an audio and visual guide that works alongside a white cane or guide dog.

## Features

- **Talk to it (Gemini Live):** Hold anywhere on the screen and ask questions like _"What's in front of me?"_, _"Where is the nearest bench?"_, or _"Take me to Worcester Dining Commons."_ The app looks through your back camera and gives answers using clock-face directions (like _"The door is at your 2 o'clock"_).
- **Audio ticks and haptics:** Once you pick a destination, stereo audio ticks pan left or right in your headphones and speed up toward the side you need to turn. When you are facing the right way, the ticks go completely silent so you can hear cars, bikes, and people around you. Android phones also vibrate.
- **X-ray mode:** For low-vision users, the camera turns off and the screen shows a high-contrast 3D wireframe of the buildings, paths, benches, and doors around you. It turns with your phone, makes your walking path glow, and puts a bright beacon on the entrance you are looking for.
- **Community hazard reports:** If a path is blocked, just say _"There's a construction fence here."_ Anyone using the app nearby gets warned within seconds, walking routes update to avoid it, and temporary reports clear themselves out automatically.

## Tech stack

- **Frontend:** React, Vite, TypeScript, Zustand, three.js (`react-three-fiber`) for X-ray mode, MapLibre for the 2D minimap, and the Web Audio API for stereo tick panning.
- **AI & Voice:** Gemini Live API (`gemini-3.8-live`) over direct browser WebSockets. Our server mints single-use ephemeral tokens so our API key stays off the client without slowing down video streaming. Eleven tools run locally on the phone to read live GPS, compass heading, and route data.
- **Maps & Routing:** A 1 MB UMass campus pack built from OpenStreetMap (buildings, paths, benches, and doors snapped to sidewalks) paired with the public FOSSGIS OSRM foot routing profile and `osrm-text-instructions`.
- **Indoor fallback:** Uses GPS outside and switches to accelerometer step counting when GPS accuracy drops near buildings, using building footprints as wall boundaries so your location doesn't drift through solid walls.
- **Backend & Database:** Hono API server and MongoDB Atlas using `2dsphere` spatial indexes for nearby/route hazard queries and TTL indexes so temporary reports expire on their own.
- **Hosting & Domain:** Deployed on a Vultr Cloud Compute instance with Docker Compose and Caddy for automatic HTTPS, using a `.boston` domain from GoDaddy Registry.

## Running it locally

### 1. Clone the repo

```bash
git clone [https://github.com/YOUR_USERNAME/hackumass-xiv.git](https://github.com/YOUR_USERNAME/hackumass-xiv.git)
cd hackumass-xiv
```

### 2. Set up environment variables

Copy the example env file and add your keys:

```bash
cp .env.example .env
```

Fill in `.env` with your credentials:

```env
GEMINI_API_KEY=your_gemini_api_key
MONGODB_URI=your_mongodb_atlas_connection_string
PORT=3000
```

### 3. Install and start

```bash
npm install
npm run dev
```

Or run the full stack with Docker Compose:

```bash
docker compose up --build
```

Note: Mobile browsers require HTTPS to access the camera, microphone, and device orientation sensors. For local phone testing, use a tunnel like `ngrok` or Caddy with local certs.

## Team

Built at HackUMass XIV by Akshat Pandey, [Teammate 2], [Teammate 3], and [Teammate 4].
