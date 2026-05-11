# Minimal example

Consumes the published-style `ocean-simple` package from the repo root (`file:../..`).

## Prerequisite

Build the library in the repository root so `dist/` exists:

```bash
cd ../..
npm install
npm run build:lib
```

## Run

```bash
npm install
npm run dev
```

This example uses **placeholder ocean textures** (missing URLs trigger the library fallback) so you do not need to copy any image assets.

The Vite config sets `build.target` to `es2022` so **top-level `await`** in `src/main.ts` works in production builds.
