# HelioVerse

Shared Three.js solar-system renderer and draggable window shell for the Helio
app family (Heliospheric, HelioWriter, ...), extracted and generalized from
Heliospheric. Internal package, consumed via local path/`npm link` (not
published to a registry). npm package name is lowercase (`helioverse`) per
npm's naming rules.

## Data contract

Consumers map their own domain onto two plain types:

```ts
type Body = {
  id: string;
  type: string;        // consumer-defined, e.g. "star" | "character" | "plot".
                        // Unknown types render as generic planets, never throw.
  label: string;
  color: string;
  scale: number;        // 0..1ish, drives render size (dwarf vs giant)
  relevance: number;    // 0..1ish, drives orbit distance from center
  parentId?: string;    // moon-orbits-planet style grouping
  status?: string;       // optional; only used for a status-color accent
};

type Link = { id: string; sourceId: string; targetId: string; label?: string };
```

Bodies with no resolvable `parentId` become root "stars" positioned around the
universe (a single root sits dead-center; multiple roots ring around the
center). Their direct children orbit as planets; planets' children orbit as
moons (tracking the parent each frame); anything deeper orbits the root as
satellites. Depth in the graph — not the `type` string — drives this tiering,
so arbitrary `type` values are always safe.

`Link`s render as relationship "shipping lanes": a faint always-on line
between the two bodies, plus a brighter animated "marching ants" dash overlay
(hand-rolled per-frame dash-segment positions, since dashOffset animation
isn't available in this Three version) when either endpoint is the current
selection. A link's `label`, if set, floats just above the midpoint of a
highlighted line.

Every body also gets an always-on floating name label with a thin leader line
back to the body, offset along a fixed screen-space direction (so leaders
stay visually consistent as the camera orbits, rather than swinging around
with the view angle).

## Controls

- Click: select/focus a body
- Left-click-hold drag: rotate camera around the current focus
- Right-click-hold drag: pan (translate the view without rotating)
- Right-click (no drag): open the pull-out action menu for the body under the cursor
- Wheel: zoom
- Double-click: enter/exit a system
- Hold Tab: open a flat hierarchical tree of every body (`NodeTreeOverview`);
  ↑/↓ or hover to browse, release Tab / Enter / click to fly the camera there

## Usage

```tsx
import { UniverseCanvas, DashboardLayout, NodeTreeOverview } from "helioverse";

<UniverseCanvas bodies={bodies} links={links} focusTargetKey={focusKey} />
<NodeTreeOverview bodies={bodies} />

<DashboardLayout leftPanel={left} rightPanel={right} mainPanel={<UniverseCanvas bodies={bodies} />} />
```

`focusKeyFor(bodyId, bodies)` builds a valid `focusTargetKey` value (it applies
the same root/child tier-prefix rule `UniverseCanvas` uses internally) — use it
instead of hand-constructing `root:`/`node:` strings in a host app.

`UniverseCanvas`, `DashboardLayout`, and `NodeTreeOverview` communicate over a
small window event bridge (`helioverse:focus-target`, `helioverse:canvas-reset`,
`helioverse:radial-action`, `helioverse:breadcrumb`) so a fly-to link
clicked in a host panel, or a pick made in the overview, can move the camera
without remounting the canvas.

## Develop

```bash
npm install
npm run build   # tsup -> dist/ (esm + cjs + d.ts)
npm test        # vitest smoke tests
```

Peer dependencies: `react`/`react-dom` ^19.2.4, `three` ^0.184.0 — install the same
versions in the consuming app.
