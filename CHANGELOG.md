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

### Changed

- A single root body now sits at the true world center instead of the
  multi-root ring layout (which only makes sense once there's more than one
  root)
- Ambient label leader lines now point along a fixed screen-space direction
  instead of a world-space offset, so they no longer swing around as the
  camera orbits
- Renamed package from `helio-sphere-ui` to `helioverse`

### Fixed

- `NodeTreeOverview`'s Tab handler now only activates when nothing else is
  focused, so it no longer steals Tab from form/dialog field navigation
- Bundled output was missing the `"use client"` directive (dropped by the
  build), breaking Next.js's server/client component boundary detection
