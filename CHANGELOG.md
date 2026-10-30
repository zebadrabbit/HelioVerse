# Changelog

All notable changes to this project should be documented in this file.

The format follows Keep a Changelog principles and Semantic Versioning.

## [Unreleased]

### Added

- Comms window mounted: `notifications` render as a typewriter feed in a
  draggable "Comms" window (rail button, `\` hotkey, auto-opens beside the
  other panels on a new notification when `autoOpenComms` is on, fades and
  closes after `chatFadeMs`)
- Package extracted and generalized from Heliospheric's universe-canvas.tsx
  and dashboard-layout.tsx: `UniverseCanvas`, `DashboardLayout`
- Domain-agnostic `Body`/`Link` data contract; unknown `type` strings render
  as generic planets instead of throwing
- `focusKeyFor` helper so host apps can build valid focus keys without
  duplicating the root/child tiering rule
- Right-click-hold pan (left-click-hold still rotates; a plain right-click
  still opens the pull-out action menu)
- `NodeTreeOverview`: hold-Tab flat hierarchical tree of every body, with
  arrow-key/hover browsing and fly-to on release/Enter/click
- Relationship line rendering for `Link`s: faint always-on line plus an
  animated "marching ants" dash overlay and floating label when either
  endpoint is selected
- Ambient floating name labels with a thin leader line back to each body
- Icon rail (EVE-Online neocom style) toggling Mission Control/Atlas
  independently, plus a Settings entry
- Settings panel and `SETTINGS_EVENT`/`SETTINGS_STORAGE_KEY` bridge: orbit
  trail opacity, space background color, render-distance LOD scale, audio
  volume/mute, and a "pretty mode" toggle -- all live-applied and persisted
- Sun-anchored `PointLight` seated at each story's star, replacing the fixed
  3-point directional rig, so illumination actually radiates from the theme
- "Pretty mode": selective bloom (`UnrealBloomPass` + `EffectComposer`) on
  just the star and its glow, via the standard darken-swap technique, so the
  rest of the scene doesn't wash out
- A body's size now gets a small nudge from how many things orbit it
  (capped at 6 children), on top of its manually-set scale
- `OPEN_EVENT`: fires when a body's "Open" action runs, so a host app can
  react (e.g. open an edit form) without this package knowing what "open"
  means for any given domain
- Single click selects and re-centers a body without changing zoom; double
  click still flies all the way in
- `Body.bloomIntensity` (optional, star-only, 0..3ish, default 1): multiplies
  the star's surface brightness, point-light intensity and glow size, so a
  host can make one story's sun burn brighter than another's (1cd3940)
- Shader-based star surface (fresnel + noise churn) replacing the flat
  `MeshStandardMaterial` sun, with a stable additive-blend bloom anchor so
  the halo stops flickering as the camera pulls back (1cd3940)
- `linkOpacity` canvas setting (0-100) with a slider in the settings panel,
  alongside orbit-trail opacity (1cd3940)
- `clustering` canvas setting (0.5x-2.5x multiplier on orbit radii, root
  ring through satellites) exposed next to render distance; safe-distance
  clamps stay unscaled so bodies still can't overlap when tightened (fc522f3)
- Planet-tier bodies split into rocky / water / gas-giant archetypes, with
  ~22% getting a ring system -- kind, rings, tilt and spin are all hash-derived
  from the body id, so no schema or form field is needed (83a2f3e, 8a9148e)
- Procedural surface textures (craters, cloud/wave blotches, turbulent gas
  bands) painted onto small canvases from a seeded PRNG so a body keeps its
  face across scene rebuilds; textures are disposed with the scene (5175b3d)
- Shadow mapping: each star's `PointLight` casts `PCFSoftShadowMap` shadows
  that orbiting bodies cast on and receive from each other; the star mesh and
  translucent ring/atmosphere overlays are excluded (fb13295)
- Banded ring systems: 3-6 concentric bands with hash-derived gaps, widths,
  shades and opacities, lit by a matte `MeshStandardMaterial` that receives
  shadows (e3c6e3b, c87e019)
- Per-body axial tilt and spin; textured planets spin by scrolling the
  texture offset rather than rotating the mesh so a ringed planet's ring
  doesn't precess (5ab6e0c)
- Relationships list in the context panel showing the selected body's edges
  and relation labels, built from the same link lines already rendered
  (1cb5744)
- Ambient asteroids (22) and comets (5, with fading trails, heads on the
  bloom layer) drifting through the scene on a closed-form sine path off the
  shared clock -- no per-frame history buffer (3aab99f)
- Smoke test asserting that an incoming notification leaves Mission Control
  and Atlas visible (6409152)

### Changed

- A single root body now sits at the true world center instead of the
  multi-root ring layout (which only makes sense once there's more than one
  root)
- Ambient label leader lines now point along a fixed screen-space direction
  instead of a world-space offset, so they no longer swing around as the
  camera orbits
- Renamed package from `helio-sphere-ui` to `helioverse`
- Mouse-drag orbit is inverted on both axes, and the vertical range now
  spans roughly ±87° instead of stopping at the upper hemisphere
- Dismissing the context panel no longer resets the camera to the origin;
  the panel hides via a `panelDismissed` flag and the camera stays on the
  selected body (1cb5744)
- Gas-giant atmosphere is a fresnel rim-only glow instead of a flat 18%
  shell that washed out the surface texture when viewed head-on (02bf672)
- Selection glow boost dropped from +0.8 to +0.3 emissive so it no longer
  clips tone mapping on textured planets (9aa53a2)
- Tone exposure 1.1 -> 0.92 and ambient fill settled at 0.68 (after 0.55 and
  0.85) for a darker deep-space look with a soft terminator (a0994e2, d1cba89)
- `three` peer range widened to `^0.184.0 || ^0.185.0`; the package itself
  now builds and tests against three 0.185.1, which is what HelioWriter
  installs (d1c3287)
- `DashboardLayout` hotkeys (`[`, `]`, `\`) are ignored while typing in an
  input, textarea, select or contenteditable (2b8a5b2)

### Removed

- Dead `DashboardLayout` config state left over from Heliospheric:
  `showHotkeyHints` (and its `h` hotkey, which toggled a boolean nothing
  read), `backgroundAtmosphere`, and the unrendered `configTab` (2b8a5b2)

### Fixed

- `NodeTreeOverview`'s Tab handler now only activates when nothing else is
  focused, so it no longer steals Tab from form/dialog field navigation
- Bundled output was missing the `"use client"` directive (dropped by the
  build), breaking Next.js's server/client component boundary detection
- `leftVisible`/`rightVisible`/layout-position state read `localStorage`
  inside `useState` initializers, which ran during the client's hydration
  render and could disagree with the server-rendered markup, breaking
  hydration; now applied client-side after mount instead
- A per-frame loop that dims background/inactive story systems was
  unconditionally overwriting every orbit line's opacity each frame,
  silently undoing the settings panel's orbit-opacity slider
- Deep-nested satellites (a satellite whose data-parent is itself a moon)
  sized their orbit clearance against their small immediate parent instead
  of the star they actually orbit in world space, so they could render
  clipped inside the star's solid sphere -- and then inside its glow halo
  once the first fix only cleared the solid radius
- The family-size size nudge was blended in a way that capped the manual
  "scale" slider's reachable range at 70% of full size for anything with
  few children (most entities); changed to additive headroom so the manual
  slider always reaches full range
- Shadowed hemispheres looked flat and texture-less because `emissive` had
  no `emissiveMap`; the surface texture is now reused as the emissive map
  (a0994e2)
- `dispatchEvent(SETTINGS_EVENT)` ran inside the `setCanvasSettings` updater,
  which React may invoke during another component's render; the first
  settings listener that called `setState` (clustering) tripped "Cannot
  update a component while rendering a different component". Side effects
  now run after the state call, off a ref (0d7b25f)
- Smoke suite had been red since 09a8000: `EffectComposer` is constructed
  unconditionally and the jsdom `FakeWebGLRenderer` lacked
  `getPixelRatio`/`shadowMap`/etc. The fake now covers what composer setup
  touches; no runtime change (e98fd98)
- Every notification hid Mission Control and Atlas to make room for a comms
  window that `DashboardLayout` never renders (HelioWriter always sends a
  boot notice, so its /app page lost both panels on every load). The hide
  and the `\` hotkey are gated behind `COMMS_WINDOW_MOUNTED` (false) until
  the comms/audio windows are either mounted or deleted (6409152)
