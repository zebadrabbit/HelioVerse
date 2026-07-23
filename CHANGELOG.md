# Changelog

All notable changes to this project should be documented in this file.

The format follows Keep a Changelog principles and Semantic Versioning.

## [Unreleased]

### Added

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
