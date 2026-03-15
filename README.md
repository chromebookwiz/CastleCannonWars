# Castle Cannon Wars

Three.js + Rapier turn-based destruction game with local skirmishes, AI captains, and Vercel-ready online room support.

## Features

- Physics-based 3D stone castles with battlements, towers, keep blocks, and manual cannon crews.
- Match presets: `1v1`, `1v1v1`, `1v1v1v1`, and `2v2`.
- Manual cannonball loading, powder charge control, aiming, recoil, smoke, sparks, and AI turns.
- Local hot-seat play or online hosted rooms using Vercel serverless APIs.

## Local Development

```bash
npm install
npm run dev
```

For end-to-end testing of the serverless room APIs locally:

```bash
npm run dev:vercel
```

## Production Build

```bash
npm run build
```

## Vercel Deployment

1. Import the repository into Vercel.
2. Add a Redis or legacy KV integration in Vercel.
3. Confirm these environment variables exist in the project:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
   - `KV_REST_API_READ_ONLY_TOKEN`
4. Deploy.

If the KV env vars are missing, online rooms fall back to an in-memory store for local development only.