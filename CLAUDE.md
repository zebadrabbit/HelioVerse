# HelioVerse

Private shared Three.js + React package: a solar-system renderer (`UniverseCanvas`), a draggable
window shell (`DashboardLayout`) and a hold-Tab tree (`NodeTreeOverview`). Built with tsup to
`dist/` (esm + cjs + d.ts); never published to a registry. README.md has the full contract,
controls and usage -- read it first; this file only covers what trips agents up.

## Commands

- `npm run build` (tsup -> `dist/`), `npm test` (jsdom smoke suite in `src/smoke.test.tsx`, fake
  WebGL renderer), `npx tsc --noEmit -p .` (typecheck). Run build and tests before committing.

## Contract and bridge

- Consumers only ever pass `Body[]` / `Link[]` (`src/universe-canvas.tsx`, top of file; README
  "Data contract"). Unknown `type` strings must keep rendering as generic planets. Appearance
  variety (archetype, rings, tilt, spin, textures) is hash-derived from `Body.id` -- don't add
  schema for it.
- Components talk over `window` CustomEvents with `helioverse:` names (`FOCUS_EVENT`,
  `SETTINGS_EVENT`, `OPEN_EVENT`, canvas-reset, radial-action, breadcrumb). Never
  `dispatchEvent` inside a React state updater (see the note in `updateCanvasSetting`).
- `src/index.ts` is the public surface; `NotificationEvent` is exported and imported by the
  consumer even though the comms window isn't mounted (`COMMS_WINDOW_MOUNTED`).

## Consumer

- `../HelioWriter` depends on `"helioverse": "file:../HelioVerse"` via a node_modules symlink, so
  it sees whatever is in `dist/` right now: after any source change, run `npm run build` here
  before building or testing HelioWriter (read it, don't edit it from here).
- Keep `peerDependencies.three` covering what HelioWriter installs (check its package.json).
