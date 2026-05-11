# Maintainers: scripts, examples, publishing

End-user documentation stays in the root [README.md](../README.md). This file is for people working in this repository.

## npm scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server for the root demo (`index.html`). |
| `npm run build:lib` | Build ESM + `.d.ts` into `dist/` for publishing. |
| `npm run build:demo` | Typecheck + build the demo site to `dist-demo/`. |
| `npm run typecheck` | Typecheck the whole `src/` tree. |
| `npm run build` | Alias for `build:demo`. |

`prepack` runs `build:lib` so `npm publish` ships a fresh `dist/`.

## Minimal consumer example (from repo clone)

```bash
npm run build:lib
cd examples/minimal
npm install
npm run dev
```

## Publishing with GitHub Actions

Workflow: [.github/workflows/publish.yaml](../.github/workflows/publish.yaml). Uses [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers) (OIDC), not a long-lived `NPM_TOKEN`.

### `E404` on publish when the package already exists on npm

npm may return **404** when the publish identity is not accepted for that package. Check, in order:

1. **GitHub Environment** — If you set an **environment** when linking the trusted publisher on npm, the workflow job must declare the same name (see commented `environment:` in `publish.yaml`). If npm has no environment, leave it commented out.

2. **Workflow filename** — Must match npm exactly, e.g. `publish.yaml` not `publish.yml`.

3. **Repository** — Must match the GitHub repo on npm (e.g. `sam-thewise/ThreeJsSimpleOcean`).

4. **`NODE_AUTH_TOKEN` / `NPM_TOKEN`** — If a secret forces classic token auth, it can override OIDC. Do not pass those for trusted publishing.

5. **Default branch** — The workflow should exist on the default branch npm expects.

### First version of a brand-new package name

If the package name has never been published, you may need one initial `npm login` + `npm publish` from your machine before OIDC can publish further versions. If the package already exists, use the checklist above instead.
