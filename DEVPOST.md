# Wayfinder — Devpost draft

Fill in the bracketed parts before submitting. Category: **Best Accessibility Hack**. Sponsor prizes: Gemini API, MongoDB Atlas, Vultr, GoDaddy Registry domain.

## Inspiration

Most navigation apps stop working the moment you walk indoors, and they assume you can see the screen. Blind and low-vision students told a different story about what goes wrong: the map is fine, but today there is a construction fence across the sidewalk, or the elevator is out, and nobody told them.

## What it does

Wayfinder is a phone web app where voice and sound are the interface.

- **Talk to it.** A Gemini Live agent sees through the camera and answers "what's in front of me?", "where's the nearest bench?" or "take me to the CS Labs", using clock-face directions.
- **Hear the way.** Once you have a destination, ticks speed up and pan toward the side you should turn, then go quiet when you face the right way. Android phones also vibrate.
- **X-ray mode.** The camera turns off and the screen shows a high-contrast wireframe of the building you are in, the buildings around it, paths, benches and doors, turning with the phone. The route glows and the target is a beacon.
- **Community reports.** Say "there's a construction fence here" and everyone nearby is warned within seconds. Routes avoid blocking reports. Temporary reports expire on their own.

## How we built it

- **Frontend:** Vite, React, TypeScript, Zustand. three.js (react-three-fiber) for x-ray, MapLibre for the minimap.
- **Voice and vision:** Gemini Live (`gemini-3.8-live`) straight from the browser over WebSocket, with single-use ephemeral tokens that lock the model, system prompt and tools on our server. Eleven tools run on the phone because they need the live position, heading and route.
- **Location indoors:** GPS when accuracy is good, step counting from the accelerometer in between, and building footprints as constraints (you cannot walk through a wall that has no door). One uncertainty value drives the accuracy circle.
- **Map data:** a 1 MB campus pack built once from OpenStreetMap: buildings, paths, and small features snapped beside the sidewalk they belong to.
- **Routing:** the public FOSSGIS OSRM foot profile, with osrm-text-instructions for sentences.
- **MongoDB Atlas:** reports stored as GeoJSON points with a `2dsphere` index for "near me" and "along my route" queries, and a TTL index so temporary hazards disappear.
- **Vultr:** one Cloud Compute instance running Docker Compose: Caddy (HTTPS, static files) and a small Hono API.
- **Domain:** [yourdomain] from GoDaddy Registry.

## Challenges

- Compass heading flips by 180° when a phone tilts past vertical. We compute the direction the back camera faces from the full orientation matrix instead.
- iOS Safari has no vibration API, so direction had to work through stereo sound alone.
- Keeping one voice: navigation prompts and hazard warnings are sent into the Gemini session as text so the same guide says everything, with browser speech as a fallback.

## What we learned

[One or two honest sentences from the team.]

## What's next

Testing with blind and low-vision students and UMass Disability Services, indoor floor plans, and fuzzy search over reports with Atlas Vector Search.

## Built with

TypeScript, React, Vite, three.js, MapLibre, Gemini Live API, MongoDB Atlas, Hono, Caddy, Docker, Vultr, OpenStreetMap, OSRM.

## AI tools used

Claude Code (Anthropic) for writing code. Gemini Live API in the product.

## Links

- Live: https://[yourdomain]
- Video: [link]
- Team: [names]
