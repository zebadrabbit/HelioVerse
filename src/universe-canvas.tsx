"use client";

/**
 * File: src/universe-canvas.tsx
 * Area: Runtime 3D rendering and interaction surface
 * Purpose: Render a generic Body/Link graph as an orbiting universe map with focus,
 *          zoom, and command pull-out behavior.
 * Origin: Extracted and generalized from Heliospheric's universe-canvas.tsx.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Copy, Crosshair, LogIn, RotateCcw, X } from "lucide-react";

/** A single node in the universe graph. Consumers map their own domain onto this. */
export type Body = {
  id: string;
  /** Consumer-defined string, e.g. "star" | "character" | "plot". Unknown types render as generic planets. */
  type: string;
  label: string;
  color: string;
  /** 0..1ish, drives render size (dwarf vs giant). */
  scale: number;
  /** 0..1ish, drives orbit distance from center. */
  relevance: number;
  /** For moon-orbits-planet style grouping. */
  parentId?: string;
  /** Optional, free-form; only used for a status-color accent when provided. */
  status?: string;
};

export type Link = { id: string; sourceId: string; targetId: string; label?: string };

// Bridge for the settings panel (rendered by DashboardLayout, a sibling
// component) to reach the canvas live -- same pattern as FOCUS_EVENT.
export const SETTINGS_EVENT = "helioverse:settings-changed";
export const SETTINGS_STORAGE_KEY = "helioverse:canvas-settings:v1";

export type CanvasSettings = {
  orbitOpacity: number; // 0-100, percent multiplier on each orbit line's base opacity
  backgroundColor: string; // hex color for the void behind the starfield
  renderDistance: number; // 0.5-2.5 multiplier on the distance-based LOD cutoffs
  prettyMode: boolean; // selective bloom on stars, for sitting back and looking at it
};

export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = {
  orbitOpacity: 100,
  backgroundColor: "#010208",
  renderDistance: 1,
  prettyMode: false,
};

function getStoredCanvasSettings(): CanvasSettings {
  if (typeof window === "undefined") {
    return DEFAULT_CANVAS_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_CANVAS_SETTINGS;
    }

    return { ...DEFAULT_CANVAS_SETTINGS, ...(JSON.parse(raw) as Partial<CanvasSettings>) };
  } catch {
    return DEFAULT_CANVAS_SETTINGS;
  }
}

/**
 * Focus keys are tier-prefixed (`root:<bodyId>` vs `node:<bodyId>`), matching
 * how layoutUniverse below classifies bodies. Exported so other components
 * (e.g. an entity list or overview UI) can build valid focusTargetKey values
 * without duplicating the root/child classification rule.
 */
export function focusKeyFor(bodyId: string, bodies: Body[]): string {
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const body = byId.get(bodyId);
  const isRoot = !body?.parentId || !byId.has(body.parentId);
  return isRoot ? `root:${bodyId}` : `node:${bodyId}`;
}

export type UniverseCanvasProps = {
  bodies: Body[];
  links?: Link[];
  viewportClassName?: string;
  focusTargetKey?: string | null;
};

type Tier = "root" | "planet" | "moon" | "satellite";

type ContextPanelState = {
  open: boolean;
  label: string;
  categoryLabel: string;
  status: string;
  accent: string;
  details: Array<{ label: string; value: string }>;
  screenX: number;
  screenY: number;
  panelX: number;
  panelY: number;
  panelOnRight: boolean;
};

type RadialAction = {
  id: string;
  label: string;
};

type RadialMenuState = {
  open: boolean;
  centerX: number;
  centerY: number;
  nearest: "left" | "right" | "top" | "bottom";
  accent: string;
  actions: RadialAction[];
};

type RadialPlacement = {
  action: RadialAction;
  x: number;
  y: number;
};

type LinkLabel = {
  id: string;
  x: number;
  y: number;
  text: string;
};

type AmbientLabel = {
  id: string;
  /** Screen position of the body itself -- where the leader line starts. */
  anchorX: number;
  anchorY: number;
  /** Screen position of the floating text -- where the leader line ends. */
  x: number;
  y: number;
  name: string;
  type: string;
  statusColor: string;
  opacity: number;
};

type BreadcrumbItem = {
  label: string;
  action: "universe" | "group" | "focus";
  groupId?: string;
  focusKey?: string;
};

type BodyLayout = Body & {
  tier: Tier;
  depth: number;
  orbitRadius: number;
  orbitMinorAxis: number;
  orbitSpeed: number;
  orbitPhase: number;
  orbitTilt: number;
  orbitOrientation: number;
  orbitVerticalAmp: number;
  size: number;
  position: THREE.Vector3;
};

type OrbitGroup = Body & {
  position: THREE.Vector3;
  radius: number;
  nodes: BodyLayout[];
};

const RENDER_QUALITY = {
  maxPixelRatio: 2.2,
  toneExposure: 1.1,
  starCount: 820,
};

// Fixed screen-space direction for ambient label leader lines (up-right),
// so labels never rotate around their body as the camera orbits.
const LEADER_LINE_ANGLE = -Math.PI / 5;

const STAR_MIN_RADIUS = 2.2;
const STAR_MAX_RADIUS = 4.6;
const PLANET_MIN_RADIUS = 0.78;
const PLANET_MAX_RADIUS = 1.84;
const MOON_MIN_RADIUS = 0.22;
const MOON_MAX_RADIUS = 0.42;
const SATELLITE_MIN_RADIUS = 0.14;
const SATELLITE_MAX_RADIUS = 0.26;

// Layer used for selective bloom in "pretty mode" -- only objects tagged
// with this layer (the star and its glow) get the bloom treatment, so the
// whole scene doesn't wash out.
const BLOOM_LAYER = 1;

const FOCUS_EVENT = "helioverse:focus-target";
const RESET_EVENT = "helioverse:canvas-reset";
const RADIAL_ACTION_EVENT = "helioverse:radial-action";
const BREADCRUMB_EVENT = "helioverse:breadcrumb";

// Fired when a body's "Open" action runs, so a consuming app can react (e.g.
// open an edit form for that body) without this generic package needing to
// know what "open" means for any particular domain.
export const OPEN_EVENT = "helioverse:open-target";

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function pickByHash(seed: string, min: number, max: number) {
  const ratio = (hashString(seed) % 1000) / 1000;
  return min + (max - min) * ratio;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function unit(value: number | undefined, fallback = 0.5) {
  return clamp(typeof value === "number" && Number.isFinite(value) ? value : fallback, 0, 1);
}

function orbitPoint(
  angle: number,
  majorAxis: number,
  minorAxis: number,
  tilt: number,
  orientation: number,
  verticalAmp: number,
) {
  const x = Math.cos(angle) * majorAxis;
  const z = Math.sin(angle) * minorAxis;
  // Keep vertical modulation 2π-periodic so orbit tracks close without a seam.
  const y = Math.sin(angle * 2) * verticalAmp;

  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const tiltedY = y * cosTilt - z * sinTilt;
  const tiltedZ = y * sinTilt + z * cosTilt;

  const cosOrientation = Math.cos(orientation);
  const sinOrientation = Math.sin(orientation);

  return new THREE.Vector3(
    x * cosOrientation - tiltedZ * sinOrientation,
    tiltedY,
    x * sinOrientation + tiltedZ * cosOrientation,
  );
}

/**
 * Lays out a Body[] graph into orbit groups. Bodies with no resolvable parent become
 * root "stars"; direct children become planets orbiting the root; their children become
 * moons tracking the parent each frame; anything deeper becomes satellites orbiting the
 * root (mirroring the original Heliospheric satellite behavior).
 */
function layoutUniverse(bodies: Body[]): OrbitGroup[] {
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const byParent = new Map<string, Body[]>();
  bodies.forEach((body) => {
    if (body.parentId && byId.has(body.parentId)) {
      const list = byParent.get(body.parentId) ?? [];
      list.push(body);
      byParent.set(body.parentId, list);
    }
  });

  const roots = bodies.filter((body) => !body.parentId || !byId.has(body.parentId));
  const groupCount = Math.max(roots.length, 1);
  const universeRadius = Math.max(36, Math.pow(groupCount, 0.92) * 30);

  // A body with a lot of moons/satellites/notes orbiting it reads as more
  // central to the story than its manually-set scale alone suggests -- add a
  // family-size nudge (capped at 6 children) on top of the manual scale.
  // This has to be additive headroom, not a blend: a blend (base * 0.7 +
  // bonus * 0.3) caps what the "Importance" slider can ever reach at 70% of
  // full size for anything with few children, which is most entities --
  // making the slider feel like it barely does anything.
  const familyScale = (nodeId: string, baseScale: number | undefined) => {
    const base = unit(baseScale);
    const childCount = byParent.get(nodeId)?.length ?? 0;
    const familyBonus = clamp(childCount / 6, 0, 1);
    return clamp(base + familyBonus * 0.18 * (1 - base), 0, 1);
  };

  return roots.map((root, rootIndex) => {
    // A single root belongs dead-center at the world origin (it's the one
    // sun of this universe); the ring layout only kicks in once there's more
    // than one story/root to arrange around that center.
    const angle = (rootIndex / groupCount) * Math.PI * 2;
    const position =
      groupCount === 1
        ? new THREE.Vector3(0, 0, 0)
        : new THREE.Vector3(
            Math.cos(angle) * universeRadius,
            pickByHash(`${root.id}:y`, -4, 4),
            Math.sin(angle) * universeRadius,
          );
    const rootRadius = THREE.MathUtils.lerp(STAR_MIN_RADIUS, STAR_MAX_RADIUS, unit(root.scale));

    const layouts: BodyLayout[] = [];
    const tier1 = byParent.get(root.id) ?? [];

    tier1.forEach((node) => {
      const relevance = unit(node.relevance);
      const eccentricity = pickByHash(`${node.id}:ecc`, 0.08, 0.42);
      const planetSize = THREE.MathUtils.lerp(PLANET_MIN_RADIUS, PLANET_MAX_RADIUS, familyScale(node.id, node.scale));
      const baseOrbitRadius = 10 + relevance * 55 + pickByHash(node.id, 1.2, 4.1);
      const safeDistanceFromRoot = rootRadius + planetSize + pickByHash(`${node.id}:root-clearance`, 0.8, 2.6);

      let orbitRadius = Math.max(baseOrbitRadius, safeDistanceFromRoot + pickByHash(`${node.id}:major-bias`, 0.2, 2.2));
      let orbitMinorAxis = orbitRadius * (1 - eccentricity * 0.82);
      if (orbitMinorAxis < safeDistanceFromRoot) {
        orbitMinorAxis = safeDistanceFromRoot;
        orbitRadius = Math.max(orbitRadius, orbitMinorAxis + pickByHash(`${node.id}:major-rebalance`, 0.25, 1.35));
      }

      const orbitSpeed = pickByHash(node.id, 0.15, 0.55);
      const orbitPhase = pickByHash(`${node.id}:phase`, 0, Math.PI * 2);
      const orbitTilt = pickByHash(`${node.id}:tilt`, -0.32, 0.32);
      const orbitOrientation = pickByHash(`${node.id}:orient`, 0, Math.PI * 2);
      const orbitVerticalAmp = pickByHash(`${node.id}:vert`, 0.08, 0.5);
      const localPosition = orbitPoint(orbitPhase, orbitRadius, orbitMinorAxis, orbitTilt, orbitOrientation, orbitVerticalAmp);

      layouts.push({
        ...node,
        tier: "planet",
        depth: 1,
        orbitRadius,
        orbitMinorAxis,
        orbitSpeed,
        orbitPhase,
        orbitTilt,
        orbitOrientation,
        orbitVerticalAmp,
        size: planetSize,
        position: new THREE.Vector3(position.x + localPosition.x, position.y + localPosition.y, position.z + localPosition.z),
      });
    });

    tier1.forEach((planet) => {
      const parentLayout = layouts.find((item) => item.id === planet.id);
      if (!parentLayout) {
        return;
      }
      const tier2 = byParent.get(planet.id) ?? [];
      tier2.forEach((node) => {
        const relevance = unit(node.relevance);
        const moonSize = THREE.MathUtils.lerp(MOON_MIN_RADIUS, MOON_MAX_RADIUS, familyScale(node.id, node.scale));
        const eccentricity = pickByHash(`${node.id}:ecc`, 0.03, 0.24);
        const baseOrbitRadius = 1.9 + relevance * 3.4 + pickByHash(node.id, 0.1, 0.8);
        const safeDistanceFromParent = parentLayout.size + moonSize + pickByHash(`${node.id}:parent-clearance`, 0.35, 1.2);

        let orbitRadius = Math.max(baseOrbitRadius, safeDistanceFromParent + pickByHash(`${node.id}:major-bias`, 0.08, 0.75));
        let orbitMinorAxis = orbitRadius * (1 - eccentricity * 0.9);
        if (orbitMinorAxis < safeDistanceFromParent) {
          orbitMinorAxis = safeDistanceFromParent;
          orbitRadius = Math.max(orbitRadius, orbitMinorAxis + pickByHash(`${node.id}:major-rebalance`, 0.05, 0.45));
        }

        const orbitSpeed = pickByHash(node.id, 0.6, 1.2);
        const orbitPhase = pickByHash(`${node.id}:phase`, 0, Math.PI * 2);
        const orbitTilt = pickByHash(`${node.id}:tilt`, -0.26, 0.26);
        const orbitOrientation = pickByHash(`${node.id}:orient`, 0, Math.PI * 2);
        const orbitVerticalAmp = pickByHash(`${node.id}:vert`, 0.03, 0.16);
        const localPosition = orbitPoint(orbitPhase, orbitRadius, orbitMinorAxis, orbitTilt, orbitOrientation, orbitVerticalAmp);

        layouts.push({
          ...node,
          tier: "moon",
          depth: 2,
          orbitRadius,
          orbitMinorAxis,
          orbitSpeed,
          orbitPhase,
          orbitTilt,
          orbitOrientation,
          orbitVerticalAmp,
          size: moonSize,
          position: new THREE.Vector3(
            parentLayout.position.x + localPosition.x,
            parentLayout.position.y + localPosition.y,
            parentLayout.position.z + localPosition.z,
          ),
        });
      });
    });

    // Anything deeper than planet/moon orbits the root directly (matches original satellite behavior).
    let satelliteIndex = 0;
    const visited = new Set<string>();
    const collectSatellites = (parentBody: Body) => {
      if (visited.has(parentBody.id)) {
        return;
      }
      visited.add(parentBody.id);

      const children = byParent.get(parentBody.id) ?? [];
      children.forEach((node) => {
        if (layouts.some((item) => item.id === node.id)) {
          return;
        }

        const parentLayout = layouts.find((item) => item.id === parentBody.id);
        // These satellites are placed in world space orbiting the root star's
        // position (below), not their immediate data-parent's position -- so
        // clearance has to respect the star's actual footprint too, or a
        // satellite nested a couple levels deep (e.g. moon-of-a-moon) ends up
        // with an orbit sized only against its small parent and renders
        // clipped inside the much bigger star. The star's glow halo (below,
        // `group.radius * 1.75`) reads as part of that footprint visually,
        // so clear that too, not just the solid sphere.
        const parentSize = Math.max(parentLayout?.size ?? 0, rootRadius * 1.75);
        const relevance = unit(node.relevance);
        const satelliteSize = THREE.MathUtils.lerp(SATELLITE_MIN_RADIUS, SATELLITE_MAX_RADIUS, familyScale(node.id, node.scale));
        const eccentricity = pickByHash(`${node.id}:ecc`, 0.14, 0.54);
        const baseOrbitRadius = 4.2 + relevance * 6 + satelliteIndex * 1.25;
        const safeDistanceFromParent = parentSize + satelliteSize + pickByHash(`${node.id}:parent-clearance`, 0.25, 1.1);

        let orbitRadius = Math.max(baseOrbitRadius, safeDistanceFromParent + pickByHash(`${node.id}:major-bias`, 0.3, 1.4));
        let orbitMinorAxis = orbitRadius * (1 - eccentricity * 0.78);
        if (orbitMinorAxis < safeDistanceFromParent) {
          orbitMinorAxis = safeDistanceFromParent;
          orbitRadius = Math.max(orbitRadius, orbitMinorAxis + pickByHash(`${node.id}:major-rebalance`, 0.2, 0.9));
        }

        const orbitSpeed = pickByHash(node.id, 0.25, 0.7);
        const orbitPhase = pickByHash(`${node.id}:phase`, 0, Math.PI * 2);
        const orbitTilt = pickByHash(`${node.id}:tilt`, -0.52, 0.52);
        const orbitOrientation = pickByHash(`${node.id}:orient`, 0, Math.PI * 2);
        const orbitVerticalAmp = pickByHash(`${node.id}:vert`, 0.06, 0.34);
        const localPosition = orbitPoint(orbitPhase, orbitRadius, orbitMinorAxis, orbitTilt, orbitOrientation, orbitVerticalAmp);

        layouts.push({
          ...node,
          tier: "satellite",
          depth: (parentLayout?.depth ?? 1) + 1,
          orbitRadius,
          orbitMinorAxis,
          orbitSpeed,
          orbitPhase,
          orbitTilt,
          orbitOrientation,
          orbitVerticalAmp,
          size: satelliteSize,
          position: new THREE.Vector3(position.x + localPosition.x, position.y + localPosition.y, position.z + localPosition.z),
        });
        satelliteIndex += 1;
        collectSatellites(node);
      });
    };

    tier1.forEach(collectSatellites);
    layouts.filter((item) => item.tier === "moon").forEach((moon) => collectSatellites(moon));

    return {
      ...root,
      position,
      radius: rootRadius,
      nodes: layouts,
    } satisfies OrbitGroup;
  });
}

function statusColor(status: string) {
  switch (status) {
    case "blocked":
      return new THREE.Color("#ff6b6b");
    case "at_risk":
      return new THREE.Color("#ffb84d");
    case "discovery":
      return new THREE.Color("#b28dff");
    case "paused":
      return new THREE.Color("#7f8794");
    default:
      return new THREE.Color("#6ee7a8");
  }
}

function statusHex(status: string) {
  return `#${statusColor(status).getHexString()}`;
}

function titleCase(value: string) {
  if (!value) {
    return "Item";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function contextActionsFor(tier: Tier | null): RadialAction[] {
  if (tier === "root") {
    return [
      { id: "focus", label: "Open" },
      { id: "dismiss", label: "Dismiss" },
    ];
  }

  if (tier) {
    return [
      { id: "focus", label: "Open" },
      { id: "dismiss", label: "Dismiss" },
    ];
  }

  return [{ id: "dismiss", label: "Dismiss" }];
}

function nearestEdge(x: number, y: number, width: number, height: number): "left" | "right" | "top" | "bottom" {
  const left = x;
  const right = width - x;
  const top = y;
  const bottom = height - y;
  const min = Math.min(left, right, top, bottom);
  if (min === left) {
    return "left";
  }
  if (min === right) {
    return "right";
  }
  if (min === top) {
    return "top";
  }
  return "bottom";
}

function edgeInwardAngle(edge: "left" | "right" | "top" | "bottom") {
  if (edge === "left") {
    return 0;
  }
  if (edge === "right") {
    return Math.PI;
  }
  if (edge === "top") {
    return Math.PI / 2;
  }
  return -Math.PI / 2;
}

function intersectsRect(
  rectA: { left: number; right: number; top: number; bottom: number },
  rectB: { left: number; right: number; top: number; bottom: number },
) {
  return rectA.left < rectB.right && rectA.right > rectB.left && rectA.top < rectB.bottom && rectA.bottom > rectB.top;
}

function radialIcon(actionId: string) {
  if (actionId === "focus") {
    return <Crosshair className="h-2.5 w-2.5" />;
  }
  if (actionId === "copy") {
    return <Copy className="h-2.5 w-2.5" />;
  }
  if (actionId === "enter-group") {
    return <LogIn className="h-2.5 w-2.5" />;
  }
  if (actionId === "reset-view") {
    return <RotateCcw className="h-2.5 w-2.5" />;
  }
  return <X className="h-2.5 w-2.5" />;
}

export function UniverseCanvas({ bodies, links = [], viewportClassName, focusTargetKey = null }: UniverseCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [selectedFocusKey, setSelectedFocusKey] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([{ label: "Universe", action: "universe" }]);
  const [panelOverflowOpen, setPanelOverflowOpen] = useState(false);
  const [contextPanel, setContextPanel] = useState<ContextPanelState>({
    open: false,
    label: "",
    categoryLabel: "",
    status: "",
    accent: "#22d3ee",
    details: [],
    screenX: 0,
    screenY: 0,
    panelX: 0,
    panelY: 0,
    panelOnRight: true,
  });
  const [radialMenu, setRadialMenu] = useState<RadialMenuState>({
    open: false,
    centerX: 0,
    centerY: 0,
    nearest: "bottom",
    accent: "#22d3ee",
    actions: [],
  });
  const [radialVisibleCount, setRadialVisibleCount] = useState(0);
  const [ambientLabels, setAmbientLabels] = useState<AmbientLabel[]>([]);
  const [linkLabels, setLinkLabels] = useState<LinkLabel[]>([]);
  const [leaderDotProgress, setLeaderDotProgress] = useState(0);

  const sceneData = useMemo(() => layoutUniverse(bodies), [bodies]);
  const radialPlacements = useMemo<RadialPlacement[]>(() => {
    if (!radialMenu.open || radialMenu.actions.length === 0) {
      return [];
    }

    const host = hostRef.current;
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    const count = Math.min(radialMenu.actions.length, 5);
    const direction = edgeInwardAngle(radialMenu.nearest);
    const start = direction - Math.PI / 2;
    const end = direction + Math.PI / 2;
    const menuItemWidth = 132;
    const menuItemHeight = 32;
    const contextRect = contextPanel.open
      ? {
          left: contextPanel.panelX - 10,
          right: contextPanel.panelX + 266,
          top: contextPanel.panelY - 10,
          bottom: contextPanel.panelY + 194,
        }
      : null;

    const placements: RadialPlacement[] = [];
    for (let index = 0; index < count; index += 1) {
      const spread = count === 1 ? 0.5 : index / (count - 1);
      const angle = start + (end - start) * spread;

      let radius = 90;
      let x = radialMenu.centerX + radius * Math.cos(angle);
      let y = radialMenu.centerY + radius * Math.sin(angle);

      for (let pass = 0; pass < 8; pass += 1) {
        const candidateRect = {
          left: x - menuItemWidth / 2,
          right: x + menuItemWidth / 2,
          top: y - menuItemHeight / 2,
          bottom: y + menuItemHeight / 2,
        };
        const itemCollision = placements.some((placed) => {
          const placedRect = {
            left: placed.x - menuItemWidth / 2,
            right: placed.x + menuItemWidth / 2,
            top: placed.y - menuItemHeight / 2,
            bottom: placed.y + menuItemHeight / 2,
          };
          return intersectsRect(candidateRect, placedRect);
        });

        const outOfBounds =
          width > 0 && height > 0
            ? candidateRect.left < 8 || candidateRect.right > width - 8 || candidateRect.top < 8 || candidateRect.bottom > height - 8
            : false;
        const panelCollision = contextRect ? intersectsRect(candidateRect, contextRect) : false;

        if (!outOfBounds && !panelCollision && !itemCollision) {
          break;
        }

        radius += 14;
        x = radialMenu.centerX + radius * Math.cos(angle);
        y = radialMenu.centerY + radius * Math.sin(angle);
      }

      placements.push({
        action: radialMenu.actions[index],
        x,
        y,
      });
    }

    return placements;
  }, [contextPanel.open, contextPanel.panelX, contextPanel.panelY, radialMenu]);

  useEffect(() => {
    if (!radialMenu.open || radialPlacements.length === 0) {
      setRadialVisibleCount(0);
      return;
    }

    setRadialVisibleCount(0);
    const timers: number[] = [];
    radialPlacements.forEach((_, index) => {
      const timer = window.setTimeout(() => {
        setRadialVisibleCount((current) => Math.max(current, index + 1));
      }, index * 25);
      timers.push(timer);
    });

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [radialMenu.open, radialPlacements]);

  useEffect(() => {
    let frame = 0;
    let animationFrame = 0;

    const animate = () => {
      frame += 1;
      setLeaderDotProgress((Math.sin(frame * 0.08) + 1) * 0.5);
      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const canvasHost = host;

    const sceneExtent = sceneData.reduce((max, group) => Math.max(max, group.position.length()), 24);
    const defaultCameraDistance = clamp(sceneExtent * 1.15 + 22, 56, 190);

    const initialSettings = getStoredCanvasSettings();
    let orbitOpacityScale = initialSettings.orbitOpacity / 100;
    let renderDistanceScale = initialSettings.renderDistance;
    let prettyMode = initialSettings.prettyMode;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(initialSettings.backgroundColor);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    camera.position.set(0, defaultCameraDistance * 0.34, defaultCameraDistance);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_QUALITY.maxPixelRatio));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = RENDER_QUALITY.toneExposure;
    canvasHost.appendChild(renderer.domElement);

    // "Pretty mode": selective bloom (only objects on BLOOM_LAYER -- the star
    // and its glow -- get the effect), using the standard darken-swap
    // technique: render bloom-layer-only objects through bloomComposer,
    // restore materials, then composite that bloom texture additively over a
    // normal render. Composers are cheap to keep around; when pretty mode is
    // off the render loop just skips straight to renderer.render().
    const bloomLayer = new THREE.Layers();
    bloomLayer.set(BLOOM_LAYER);
    const bloomDarkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const bloomMaterialCache = new Map<string, THREE.Material | THREE.Material[]>();

    const darkenNonBloomed = (object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh && !bloomLayer.test(object.layers)) {
        bloomMaterialCache.set(object.uuid, object.material);
        object.material = bloomDarkMaterial;
      }
    };
    const restoreMaterial = (object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh && bloomMaterialCache.has(object.uuid)) {
        object.material = bloomMaterialCache.get(object.uuid)!;
        bloomMaterialCache.delete(object.uuid);
      }
    };

    const bloomComposer = new EffectComposer(renderer);
    bloomComposer.renderToScreen = false;
    bloomComposer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(host.clientWidth, host.clientHeight), 1.1, 0.55, 0.15);
    bloomComposer.addPass(bloomPass);

    const bloomMixPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          baseTexture: { value: null },
          bloomTexture: { value: bloomComposer.renderTarget2.texture },
        },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform sampler2D baseTexture;
          uniform sampler2D bloomTexture;
          varying vec2 vUv;
          void main() {
            gl_FragColor = texture2D(baseTexture, vUv) + vec4(1.0) * texture2D(bloomTexture, vUv);
          }
        `,
      }),
      "baseTexture",
    );
    bloomMixPass.needsSwap = true;

    const finalComposer = new EffectComposer(renderer);
    finalComposer.addPass(new RenderPass(scene, camera));
    finalComposer.addPass(bloomMixPass);
    finalComposer.addPass(new OutputPass());

    const renderBloomed = () => {
      scene.traverse(darkenNonBloomed);
      bloomComposer.render();
      scene.traverse(restoreMaterial);
      finalComposer.render();
    };

    // Fill light only -- keeps shadowed sides visible instead of pure black.
    // Actual illumination comes from a PointLight seated at each star (added
    // alongside its root mesh below), so light direction tracks the sun
    // instead of a fixed world-space rig.
    const ambient = new THREE.AmbientLight(0xb8c8ff, 0.55);
    scene.add(ambient);

    const starGeometry = new THREE.BufferGeometry();
    const starCount = RENDER_QUALITY.starCount;
    const starPositions = new Float32Array(starCount * 3);
    for (let index = 0; index < starCount; index += 1) {
      const radius = 180 + Math.random() * 250;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
      starPositions[index * 3] = Math.sin(phi) * Math.cos(theta) * radius;
      starPositions[index * 3 + 1] = Math.cos(phi) * radius * 0.45;
      starPositions[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;
    }
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0xb6c7ff,
      size: 0.6,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const starField = new THREE.Points(starGeometry, starMaterial);
    scene.add(starField);

    const nebulaA = new THREE.Mesh(
      new THREE.SphereGeometry(250, 42, 42),
      new THREE.MeshBasicMaterial({
        color: 0x2f5fff,
        transparent: true,
        opacity: 0.06,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    nebulaA.scale.set(1.2, 0.48, 1.15);
    scene.add(nebulaA);

    const nebulaB = new THREE.Mesh(
      new THREE.SphereGeometry(210, 36, 36),
      new THREE.MeshBasicMaterial({
        color: 0x37d4a4,
        transparent: true,
        opacity: 0.045,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    nebulaB.scale.set(1, 0.42, 1.32);
    scene.add(nebulaB);

    const groupRoot = new THREE.Group();
    scene.add(groupRoot);
    const pickables: THREE.Mesh[] = [];
    const meshById = new Map<string, THREE.Mesh>();
    const nodeMeshesByGroup: Map<string, THREE.Mesh>[] = [];
    const moonOrbitTracksByGroup: Array<Array<{ line: THREE.LineLoop; parentId: string | null }>> = [];
    const orbitTracks: Array<{ line: THREE.LineLoop; tier: Tier }> = [];
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const cameraFocus = new THREE.Vector3(0, 0, 0);
    const targetFocus = new THREE.Vector3(0, 0, 0);
    let cameraDistance = defaultCameraDistance;
    let desiredDistance = defaultCameraDistance;
    let cameraYaw = 0;
    let cameraPitch = 0.34;
    let yawVelocity = 0;
    let pitchVelocity = 0;
    let zoomVelocity = 0;
    let activeGroupId: string | null = null;
    let transitionUntil = 0;
    let lastOverlayUpdate = 0;
    let lastLabelUpdate = 0;
    let selectedMesh: THREE.Mesh | null = null;
    let dragPointerId: number | null = null;
    let dragButton: number | null = null;
    let isDragging = false;
    let didDrag = false;
    let lastDragWasPan = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let lastDragX = 0;
    let lastDragY = 0;
    let longPressTimer: number | null = null;
    const panRight = new THREE.Vector3();
    const panUp = new THREE.Vector3();
    const panForward = new THREE.Vector3();
    const panOffset = new THREE.Vector3();

    const createOrbitLine = (
      majorAxis: number,
      minorAxis: number,
      tilt: number,
      orientation: number,
      verticalAmp: number,
      color: number,
      opacity: number,
      segments = 96,
    ) => {
      const points: THREE.Vector3[] = [];
      for (let index = 0; index < segments; index += 1) {
        const angle = (index / segments) * Math.PI * 2;
        points.push(orbitPoint(angle, majorAxis, minorAxis, tilt, orientation, verticalAmp));
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: opacity * orbitOpacityScale,
        depthWrite: false,
      });

      const line = new THREE.LineLoop(geometry, material);
      line.userData.baseOpacity = opacity;
      return line;
    };

    sceneData.forEach((group) => {
      const groupNode = new THREE.Group();
      groupNode.position.copy(group.position);
      groupRoot.add(groupNode);
      const nodeMeshMap = new Map<string, THREE.Mesh>();
      const moonTracks: Array<{ line: THREE.LineLoop; parentId: string | null }> = [];

      const rootColor = new THREE.Color(group.color || "#6ee7a8");
      const rootMaterial = new THREE.MeshStandardMaterial({
        color: rootColor,
        emissive: rootColor,
        emissiveIntensity: 1.2,
        roughness: 0.25,
        metalness: 0.05,
      });
      const rootMesh = new THREE.Mesh(new THREE.SphereGeometry(group.radius, 32, 32), rootMaterial);
      const childCount = group.nodes.length;
      rootMesh.userData = {
        kind: "root",
        tier: "root" as Tier,
        type: group.type,
        groupId: group.id,
        bodyId: group.id,
        label: group.label,
        status: group.status ?? "",
        labelSize: group.radius,
        focusKey: `root:${group.id}`,
        focusDistance: Math.max(8, group.radius * 8.5),
        details: [{ label: "Children", value: String(childCount) }],
      };
      groupNode.add(rootMesh);
      pickables.push(rootMesh);
      meshById.set(group.id, rootMesh);
      rootMesh.layers.enable(BLOOM_LAYER);

      const sunLight = new THREE.PointLight(0xfff2d6, Math.max(900, group.radius * 700), 0, 1.7);
      sunLight.position.set(0, 0, 0);
      groupNode.add(sunLight);

      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(group.radius * 1.75, 32, 32),
        new THREE.MeshBasicMaterial({
          color: rootColor,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
        }),
      );
      glow.layers.enable(BLOOM_LAYER);
      groupNode.add(glow);

      group.nodes.forEach((node) => {
        const nodeColor = new THREE.Color(node.color || "#6ee7a8");
        let mesh: THREE.Mesh;

        if (node.tier === "satellite") {
          mesh = new THREE.Mesh(
            new THREE.BoxGeometry(node.size, node.size, node.size),
            new THREE.MeshStandardMaterial({
              color: nodeColor,
              emissive: nodeColor,
              emissiveIntensity: 0.5,
              roughness: 0.35,
              metalness: 0.15,
            }),
          );
        } else {
          mesh = new THREE.Mesh(
            new THREE.SphereGeometry(node.size, 24, 24),
            new THREE.MeshStandardMaterial({
              color: nodeColor,
              emissive: nodeColor,
              emissiveIntensity: node.tier === "moon" ? 0.35 : 0.24,
              roughness: 0.46,
              metalness: 0.1,
            }),
          );
        }

        const parentLabel = node.parentId
          ? (group.nodes.find((entry) => entry.id === node.parentId)?.label ?? (node.parentId === group.id ? group.label : "Unknown"))
          : group.label;
        const childCountForNode = group.nodes.filter((entry) => entry.parentId === node.id).length;

        mesh.position.copy(node.position.clone().sub(group.position));
        mesh.userData = {
          kind: "node",
          tier: node.tier,
          type: node.type,
          groupId: group.id,
          bodyId: node.id,
          label: node.label,
          status: node.status ?? "",
          labelSize: node.size,
          parentId: node.parentId ?? null,
          focusKey: `node:${node.id}`,
          focusDistance: Math.max(2.5, node.size * (node.tier === "moon" ? 12 : node.tier === "satellite" ? 16 : 10)),
          details: [
            { label: "Parent", value: parentLabel },
            { label: "Children", value: String(childCountForNode) },
          ],
        };
        groupNode.add(mesh);
        pickables.push(mesh);
        nodeMeshMap.set(node.id, mesh);
        meshById.set(node.id, mesh);

        if (node.tier === "planet") {
          const orbitPath = createOrbitLine(
            node.orbitRadius,
            node.orbitMinorAxis,
            node.orbitTilt,
            node.orbitOrientation,
            node.orbitVerticalAmp,
            0xae95ff,
            0.32,
            160,
          );
          groupNode.add(orbitPath);
          orbitTracks.push({ line: orbitPath, tier: node.tier });
        }

        if (node.tier === "satellite") {
          const orbitPath = createOrbitLine(
            node.orbitRadius,
            node.orbitMinorAxis,
            node.orbitTilt,
            node.orbitOrientation,
            node.orbitVerticalAmp,
            0x8fe4d7,
            0.24,
            132,
          );
          groupNode.add(orbitPath);
          orbitTracks.push({ line: orbitPath, tier: node.tier });
        }

        if (node.tier === "moon") {
          const orbitPath = createOrbitLine(
            node.orbitRadius,
            node.orbitMinorAxis,
            node.orbitTilt,
            node.orbitOrientation,
            node.orbitVerticalAmp,
            0xb9d4ff,
            0.2,
            84,
          );
          orbitPath.position.copy(mesh.position);
          groupNode.add(orbitPath);
          orbitTracks.push({ line: orbitPath, tier: node.tier });
          moonTracks.push({ line: orbitPath, parentId: node.parentId ?? null });
        }
      });

      nodeMeshesByGroup.push(nodeMeshMap);
      moonOrbitTracksByGroup.push(moonTracks);
    });

    // Relationship "shipping lanes": a faint always-on line, plus a "marching
    // ants" dash overlay that lights up and animates along the line when
    // either endpoint is the current selection. (Three's built-in dashed-line
    // dashOffset animation isn't available in this Three version, so the
    // marching effect is hand-rolled by rewriting dash-segment positions
    // each frame instead.)
    const ANT_COUNT = 5;
    const ANT_FRACTION = 0.16;
    type LinkLine = {
      line: THREE.Line;
      antsLine: THREE.LineSegments;
      sourceMesh: THREE.Mesh;
      targetMesh: THREE.Mesh;
      sourceId: string;
      targetId: string;
      label?: string;
    };
    const mutedLinkMaterial = new THREE.LineBasicMaterial({
      color: 0x8fb4d9,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
    });
    const antsMaterial = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const linkLines: LinkLine[] = [];
    links.forEach((link) => {
      const sourceMesh = meshById.get(link.sourceId);
      const targetMesh = meshById.get(link.targetId);
      if (!sourceMesh || !targetMesh) {
        return;
      }
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geometry, mutedLinkMaterial);
      scene.add(line);

      const antsGeometry = new THREE.BufferGeometry();
      antsGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ANT_COUNT * 2 * 3), 3));
      const antsLine = new THREE.LineSegments(antsGeometry, antsMaterial);
      antsLine.visible = false;
      scene.add(antsLine);

      linkLines.push({ line, antsLine, sourceMesh, targetMesh, sourceId: link.sourceId, targetId: link.targetId, label: link.label });
    });

    const worldToScreen = (world: THREE.Vector3) => {
      const projected = world.clone().project(camera);
      const width = canvasHost.clientWidth;
      const height = canvasHost.clientHeight;
      return {
        z: projected.z,
        x: (projected.x * 0.5 + 0.5) * width,
        y: (-projected.y * 0.5 + 0.5) * height,
      };
    };

    const radialActionsFor = (mesh: THREE.Mesh): RadialAction[] => {
      const tier = mesh.userData.tier as Tier;
      if (tier === "root") {
        return [
          { id: "enter-group", label: "Enter" },
          { id: "focus", label: "Focus" },
          { id: "copy", label: "Copy" },
          { id: "dismiss", label: "Dismiss" },
        ];
      }

      return [
        { id: "focus", label: "Focus" },
        { id: "copy", label: "Copy" },
        { id: "reset-view", label: "Reset" },
        { id: "dismiss", label: "Dismiss" },
      ];
    };

    const openRadialMenu = (mesh: THREE.Mesh, clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      const accent = material?.color ? `#${material.color.getHexString()}` : "#22d3ee";

      setRadialMenu({
        open: true,
        centerX: localX,
        centerY: localY,
        nearest: nearestEdge(localX, localY, rect.width, rect.height),
        accent,
        actions: radialActionsFor(mesh).slice(0, 5),
      });
    };

    const setGroupView = (groupId: string | null) => {
      activeGroupId = groupId;
      transitionUntil = performance.now() + 1850;

      if (!groupId) {
        targetFocus.set(0, 0, 0);
        desiredDistance = defaultCameraDistance;
        setBreadcrumb([{ label: "Universe", action: "universe" }]);
        return;
      }

      const group = sceneData.find((entry) => entry.id === groupId) ?? null;
      if (!group) {
        return;
      }

      targetFocus.copy(group.position);
      desiredDistance = clamp(group.radius * 9.5, 18, 62);
      setBreadcrumb([
        { label: "Universe", action: "universe" },
        { label: group.label, action: "group", groupId },
      ]);
    };

    const setSelection = (mesh: THREE.Mesh | null, flyTo = true) => {
      if (selectedMesh && selectedMesh !== mesh) {
        const material = selectedMesh.material as THREE.MeshStandardMaterial | undefined;
        if (material) {
          material.emissiveIntensity = selectedMesh.userData.baseEmissiveIntensity ?? material.emissiveIntensity;
        }
      }

      selectedMesh = mesh;

      if (!mesh) {
        if (!activeGroupId) {
          targetFocus.set(0, 0, 0);
          desiredDistance = defaultCameraDistance;
        }
        setSelectedFocusKey(null);
        setSelectedTier(null);
        setPanelOverflowOpen(false);
        setContextPanel((current) => ({ ...current, open: false }));
        setRadialMenu((current) => ({ ...current, open: false }));
        return;
      }

      const selectedWorldPosition = new THREE.Vector3();
      mesh.getWorldPosition(selectedWorldPosition);
      targetFocus.copy(selectedWorldPosition);
      if (flyTo) {
        desiredDistance = clamp(mesh.userData.focusDistance ?? 10, 2, 170);
      }
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (material) {
        if (mesh.userData.baseEmissiveIntensity === undefined) {
          mesh.userData.baseEmissiveIntensity = material.emissiveIntensity;
        }
        material.emissiveIntensity = (mesh.userData.baseEmissiveIntensity ?? 0.2) + 0.8;
      }

      const name = mesh.userData.label as string;
      const tier = mesh.userData.tier as Tier;
      const type = mesh.userData.type as string;
      const focusKey = mesh.userData.focusKey as string;
      const categoryLabel = titleCase(type);
      const meshMaterial = mesh.material as THREE.MeshStandardMaterial | undefined;
      const accent = meshMaterial?.color ? `#${meshMaterial.color.getHexString()}` : "#22d3ee";
      setSelectedFocusKey(focusKey);
      setSelectedTier(tier);
      setPanelOverflowOpen(false);

      const nextBreadcrumb: BreadcrumbItem[] = [
        { label: "Universe", action: "universe" },
        { label: sceneData.find((entry) => entry.id === (mesh.userData.groupId as string))?.label ?? "", action: "group", groupId: mesh.userData.groupId as string },
      ];

      if (tier !== "root") {
        nextBreadcrumb.push({ label: name, action: "focus", focusKey });
      }

      setBreadcrumb(nextBreadcrumb);

      const screen = worldToScreen(selectedWorldPosition);
      const panelOnRight = screen.x < canvasHost.clientWidth * 0.52;
      const panelX = clamp(
        screen.x + (panelOnRight ? 112 : -288),
        10,
        Math.max(10, canvasHost.clientWidth - 256),
      );
      const panelY = clamp(screen.y - 92, 10, Math.max(10, canvasHost.clientHeight - 168));

      setContextPanel({
        open: true,
        label: name,
        categoryLabel,
        status: mesh.userData.status as string,
        accent,
        details: (mesh.userData.details as Array<{ label: string; value: string }> | undefined) ?? [],
        screenX: screen.x,
        screenY: screen.y,
        panelX,
        panelY,
        panelOnRight,
      });
    };

    const pickAt = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(pickables, false);

      if (intersections.length > 0) {
        return intersections[0].object as THREE.Mesh;
      }

      return null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) {
        return;
      }

      dragPointerId = event.pointerId;
      dragButton = event.button;
      isDragging = true;
      didDrag = false;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      lastDragX = event.clientX;
      lastDragY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);

      if (event.button === 0 && event.pointerType !== "mouse") {
        longPressTimer = window.setTimeout(() => {
          const picked = pickAt(event.clientX, event.clientY);
          if (!picked) {
            return;
          }

          setSelection(picked);
          openRadialMenu(picked, event.clientX, event.clientY);
        }, 420);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isDragging || event.pointerId !== dragPointerId) {
        return;
      }

      const moveX = event.clientX - lastDragX;
      const moveY = event.clientY - lastDragY;
      const totalMoveX = event.clientX - dragStartX;
      const totalMoveY = event.clientY - dragStartY;

      if (Math.abs(totalMoveX) > 3 || Math.abs(totalMoveY) > 3) {
        didDrag = true;
        if (longPressTimer !== null) {
          window.clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }

      if (didDrag && dragButton === 2) {
        // Pan: translate the orbit center along the camera's current right/up axes,
        // scaled by distance so drag speed feels consistent whether zoomed in or out.
        camera.matrixWorld.extractBasis(panRight, panUp, panForward);
        const panSpeed = cameraDistance * 0.0016;
        panOffset
          .copy(panRight)
          .multiplyScalar(-moveX * panSpeed)
          .addScaledVector(panUp, moveY * panSpeed);
        cameraFocus.add(panOffset);
        targetFocus.add(panOffset);
      } else if (didDrag) {
        const nextYawDelta = moveX * 0.005;
        const nextPitchDelta = moveY * 0.0035;
        cameraYaw += nextYawDelta;
        cameraPitch = clamp(cameraPitch + nextPitchDelta, -1.52, 1.52);
        yawVelocity = nextYawDelta;
        pitchVelocity = nextPitchDelta;
      }

      lastDragX = event.clientX;
      lastDragY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) {
        return;
      }

      if (!didDrag && dragButton === 0) {
        const picked = pickAt(event.clientX, event.clientY);
        if (picked) {
          setSelection(picked, false);
        } else {
          setSelection(null);
        }
      }

      lastDragWasPan = didDrag && dragButton === 2;
      isDragging = false;
      didDrag = false;
      dragPointerId = null;
      dragButton = null;
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    };

    const onDoubleClick = (event: MouseEvent) => {
      const picked = pickAt(event.clientX, event.clientY);
      if (picked && picked.userData.tier === "root") {
        setSelection(picked);
        setGroupView(picked.userData.groupId as string);
        return;
      }

      if (picked) {
        setSelection(picked, true);
        return;
      }

      if (activeGroupId) {
        setSelection(null);
        setGroupView(null);
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const speed = selectedMesh ? 0.00075 : 0.00095;
      zoomVelocity += event.deltaY * speed * desiredDistance;
    };

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (lastDragWasPan) {
        lastDragWasPan = false;
        return;
      }
      const picked = pickAt(event.clientX, event.clientY);
      if (!picked) {
        setRadialMenu((current) => ({ ...current, open: false }));
        return;
      }

      setSelection(picked);
      openRadialMenu(picked, event.clientX, event.clientY);
    };

    const runRadialAction = (actionId: string) => {
      if (!selectedMesh) {
        setRadialMenu((current) => ({ ...current, open: false }));
        return;
      }

      if (actionId === "focus") {
        setSelection(selectedMesh);
        window.dispatchEvent(
          new CustomEvent(OPEN_EVENT, {
            detail: {
              bodyId: selectedMesh.userData.bodyId as string,
              tier: selectedMesh.userData.tier as Tier,
            },
          }),
        );
      }

      if (actionId === "enter-group" && selectedMesh.userData.tier === "root") {
        setGroupView(selectedMesh.userData.groupId as string);
      }

      if (actionId === "reset-view") {
        setSelection(null);
        setGroupView(activeGroupId);
      }

      if (actionId === "copy") {
        const key = selectedMesh.userData.focusKey as string | undefined;
        if (key && navigator.clipboard) {
          void navigator.clipboard.writeText(key);
        }
      }

      if (actionId === "dismiss") {
        setSelection(null);
      }

      setRadialMenu((current) => ({ ...current, open: false }));
    };

    const focusByKey = (focusKey: string | null) => {
      if (!focusKey) {
        return;
      }

      const targetMesh = pickables.find((mesh) => mesh.userData.focusKey === focusKey) ?? null;
      if (targetMesh) {
        setSelection(targetMesh);
      }
    };

    const onFocusEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ focusKey?: string }>).detail;
      focusByKey(detail?.focusKey ?? null);
    };

    const onResetEvent = () => {
      setSelection(null);
      setGroupView(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setSelection(null);
      if (activeGroupId) {
        setGroupView(null);
      }
    };

    const onRadialActionEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail;
      if (!detail?.id) {
        return;
      }

      runRadialAction(detail.id);
    };

    const onBreadcrumbEvent = (event: Event) => {
      const detail = (event as CustomEvent<BreadcrumbItem>).detail;
      if (!detail) {
        return;
      }

      if (detail.action === "universe") {
        setSelection(null);
        setGroupView(null);
        return;
      }

      if (detail.action === "group") {
        setSelection(null);
        setGroupView(detail.groupId ?? null);
        return;
      }

      if (detail.action === "focus") {
        focusByKey(detail.focusKey ?? null);
      }
    };

    focusByKey(focusTargetKey);

    const onSettingsEvent = (event: Event) => {
      const detail = (event as CustomEvent<Partial<CanvasSettings>>).detail;
      if (!detail) {
        return;
      }

      if (typeof detail.backgroundColor === "string") {
        scene.background = new THREE.Color(detail.backgroundColor);
      }

      if (typeof detail.orbitOpacity === "number") {
        // The per-frame animate loop re-applies this scale to every orbit
        // line's opacity (using each line's userData.baseOpacity), so no
        // direct material mutation is needed here.
        orbitOpacityScale = detail.orbitOpacity / 100;
      }

      if (typeof detail.renderDistance === "number") {
        renderDistanceScale = detail.renderDistance;
      }

      if (typeof detail.prettyMode === "boolean") {
        prettyMode = detail.prettyMode;
      }
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("dblclick", onDoubleClick);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener(FOCUS_EVENT, onFocusEvent as EventListener);
    window.addEventListener(RESET_EVENT, onResetEvent as EventListener);
    window.addEventListener(RADIAL_ACTION_EVENT, onRadialActionEvent as EventListener);
    window.addEventListener(BREADCRUMB_EVENT, onBreadcrumbEvent as EventListener);
    window.addEventListener(SETTINGS_EVENT, onSettingsEvent as EventListener);
    window.addEventListener("keydown", onKeyDown);

    const resizeObserver = new ResizeObserver(() => {
      const { width, height } = canvasHost.getBoundingClientRect();
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      bloomComposer.setSize(width, height);
      finalComposer.setSize(width, height);
    });
    resizeObserver.observe(canvasHost);

    let frame = 0;
    let animationFrame = 0;
    const animate = () => {
      frame += 1;
      const time = frame * 0.005;
      const inTransition = performance.now() < transitionUntil;
      const focusBlend = inTransition ? 0.045 : 0.085;
      const distanceBlend = inTransition ? 0.055 : 0.11;

      if (!isDragging) {
        cameraYaw += selectedMesh ? 0.0024 : 0.0014;
        cameraYaw += yawVelocity;
        cameraPitch = clamp(cameraPitch + pitchVelocity, -1.52, 1.52);
        yawVelocity *= 0.9;
        pitchVelocity *= 0.88;
        if (Math.abs(yawVelocity) < 0.00002) {
          yawVelocity = 0;
        }
        if (Math.abs(pitchVelocity) < 0.00002) {
          pitchVelocity = 0;
        }
      }

      if (Math.abs(zoomVelocity) > 0.001) {
        desiredDistance = clamp(desiredDistance + zoomVelocity, 2, 170);
        zoomVelocity *= 0.84;
      } else {
        zoomVelocity = 0;
      }

      cameraFocus.lerp(targetFocus, focusBlend);
      cameraDistance = THREE.MathUtils.lerp(cameraDistance, desiredDistance, distanceBlend);

      sceneData.forEach((group, groupIndex) => {
        const groupNode = groupRoot.children[groupIndex];
        const nodeMeshMap = nodeMeshesByGroup[groupIndex];
        const moonTracks = moonOrbitTracksByGroup[groupIndex] ?? [];
        if (!groupNode) {
          return;
        }

        const isActiveGroup = !activeGroupId || group.id === activeGroupId;
        const targetOpacity = isActiveGroup ? 1 : 0.14;
        const currentOpacity = typeof groupNode.userData.opacity === "number" ? groupNode.userData.opacity : 1;
        const nextOpacity = THREE.MathUtils.lerp(currentOpacity, targetOpacity, 0.075);
        groupNode.userData.opacity = nextOpacity;
        groupNode.visible = nextOpacity > 0.02;
        groupNode.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            if (Array.isArray(object.material)) {
              object.material.forEach((material) => {
                material.transparent = true;
                material.opacity = nextOpacity;
              });
            } else {
              object.material.transparent = true;
              object.material.opacity = nextOpacity;
            }
          }

          if (object instanceof THREE.LineLoop) {
            const trackBaseOpacity = typeof object.userData.baseOpacity === "number" ? object.userData.baseOpacity : 0.38;
            const lineOpacity = nextOpacity * orbitOpacityScale * trackBaseOpacity;
            if (Array.isArray(object.material)) {
              object.material.forEach((material) => {
                material.transparent = true;
                material.opacity = lineOpacity;
              });
            } else {
              object.material.transparent = true;
              object.material.opacity = lineOpacity;
            }
          }
        });

        const rootMesh = groupNode.children[0] as THREE.Mesh | undefined;
        if (rootMesh) {
          const pulse = 1 + Math.sin(time * 2 + groupIndex) * 0.02;
          rootMesh.scale.setScalar(pulse);
        }

        group.nodes.forEach((node) => {
          const nodeMesh = nodeMeshMap?.get(node.id);
          if (!nodeMesh) {
            return;
          }

          if (node.tier === "planet" || node.tier === "satellite") {
            const angle = time * node.orbitSpeed + node.orbitPhase;
            const localPosition = orbitPoint(
              angle,
              node.orbitRadius,
              node.orbitMinorAxis,
              node.orbitTilt,
              node.orbitOrientation,
              node.orbitVerticalAmp,
            );
            nodeMesh.position.copy(localPosition);
          }

          if (node.tier === "moon") {
            const parentMesh = node.parentId ? nodeMeshMap?.get(node.parentId) : undefined;
            const parentPosition = parentMesh?.position ?? new THREE.Vector3();
            const angle = time * node.orbitSpeed + node.orbitPhase;
            const localPosition = orbitPoint(
              angle,
              node.orbitRadius,
              node.orbitMinorAxis,
              node.orbitTilt,
              node.orbitOrientation,
              node.orbitVerticalAmp,
            );
            nodeMesh.position.set(
              parentPosition.x + localPosition.x,
              parentPosition.y + localPosition.y,
              parentPosition.z + localPosition.z,
            );
          }
        });

        moonTracks.forEach((track) => {
          const parentMesh = track.parentId ? nodeMeshMap?.get(track.parentId) : undefined;
          const parentPosition = parentMesh?.position ?? new THREE.Vector3();
          track.line.position.copy(parentPosition);
        });
      });

      const antPhase = ((-time * 0.55) % 1 + 1) % 1;
      const selectedBodyId = selectedMesh?.userData.bodyId as string | undefined;
      const sourceWorld = new THREE.Vector3();
      const targetWorld = new THREE.Vector3();
      linkLines.forEach((linkLine) => {
        linkLine.sourceMesh.getWorldPosition(sourceWorld);
        linkLine.targetMesh.getWorldPosition(targetWorld);
        const position = linkLine.line.geometry.attributes.position as THREE.BufferAttribute;
        position.setXYZ(0, sourceWorld.x, sourceWorld.y, sourceWorld.z);
        position.setXYZ(1, targetWorld.x, targetWorld.y, targetWorld.z);
        position.needsUpdate = true;
        linkLine.line.geometry.computeBoundingSphere();

        const isHighlighted =
          selectedBodyId !== undefined && (linkLine.sourceId === selectedBodyId || linkLine.targetId === selectedBodyId);
        linkLine.antsLine.visible = isHighlighted;
        if (isHighlighted) {
          const antsPosition = linkLine.antsLine.geometry.attributes.position as THREE.BufferAttribute;
          for (let ant = 0; ant < ANT_COUNT; ant += 1) {
            const t0 = clamp((ant / ANT_COUNT + antPhase) % 1, 0, 1);
            const t1 = clamp(t0 + ANT_FRACTION / ANT_COUNT, 0, 1);
            antsPosition.setXYZ(ant * 2, sourceWorld.x + (targetWorld.x - sourceWorld.x) * t0, sourceWorld.y + (targetWorld.y - sourceWorld.y) * t0, sourceWorld.z + (targetWorld.z - sourceWorld.z) * t0);
            antsPosition.setXYZ(ant * 2 + 1, sourceWorld.x + (targetWorld.x - sourceWorld.x) * t1, sourceWorld.y + (targetWorld.y - sourceWorld.y) * t1, sourceWorld.z + (targetWorld.z - sourceWorld.z) * t1);
          }
          antsPosition.needsUpdate = true;
          linkLine.antsLine.geometry.computeBoundingSphere();
        }
      });

      // Cull fine-grain objects by distance to keep frame-time stable at scale.
      for (const mesh of pickables) {
        if (mesh.userData.kind !== "node") {
          mesh.visible = true;
          continue;
        }

        const tier = mesh.userData.tier as Tier;
        if (cameraDistance > 95 * renderDistanceScale && (tier === "moon" || tier === "satellite")) {
          mesh.visible = false;
        } else if (cameraDistance > 145 * renderDistanceScale && tier === "planet") {
          mesh.visible = false;
        } else {
          mesh.visible = true;
        }
      }

      orbitTracks.forEach((track) => {
        if (cameraDistance > 150 * renderDistanceScale && track.tier !== "planet") {
          track.line.visible = false;
        } else if (cameraDistance > 100 * renderDistanceScale && track.tier === "moon") {
          track.line.visible = false;
        } else {
          track.line.visible = true;
        }
      });

      if (performance.now() - lastLabelUpdate > 48) {
        const nextLabels: AmbientLabel[] = [];
        const distanceFade = clamp(1 - (cameraDistance - 58) / 86, 0, 1);

        if (distanceFade > 0.01) {
          for (const mesh of pickables) {
            if (!mesh.visible) {
              continue;
            }

            const world = new THREE.Vector3();
            mesh.getWorldPosition(world);
            const labelSize = typeof mesh.userData.labelSize === "number" ? mesh.userData.labelSize : 1;
            // Derive the leader length from a world-space offset (so it still
            // scales with body size and camera distance), but apply it along a
            // fixed screen-space direction -- otherwise the same world-space
            // offset projects to a different on-screen angle depending on
            // camera orientation, making leaders swing around as you orbit.
            const anchor = world.clone();
            anchor.x += labelSize * 2.1 + 1.1;
            anchor.y += labelSize * 2.1 + 1.1;
            const bodyScreen = worldToScreen(world);
            const rawAnchorScreen = worldToScreen(anchor);
            const magnitude = clamp(Math.hypot(rawAnchorScreen.x - bodyScreen.x, rawAnchorScreen.y - bodyScreen.y), 18, 160);
            const screen = {
              x: bodyScreen.x + Math.cos(LEADER_LINE_ANGLE) * magnitude,
              y: bodyScreen.y + Math.sin(LEADER_LINE_ANGLE) * magnitude,
              z: rawAnchorScreen.z,
            };
            if (screen.z < -1 || screen.z > 1) {
              continue;
            }
            if (screen.x < 8 || screen.x > canvasHost.clientWidth - 8 || screen.y < 8 || screen.y > canvasHost.clientHeight - 8) {
              continue;
            }

            const groupOpacity = typeof mesh.parent?.userData.opacity === "number" ? mesh.parent.userData.opacity : 1;
            const opacity = clamp(distanceFade * groupOpacity, 0, 1);
            if (opacity < 0.035) {
              continue;
            }

            nextLabels.push({
              id: String(mesh.userData.focusKey ?? mesh.uuid),
              anchorX: bodyScreen.x,
              anchorY: bodyScreen.y,
              x: screen.x,
              y: screen.y,
              name: String(mesh.userData.label ?? "Unknown"),
              type: String(mesh.userData.type ?? "item").toUpperCase(),
              statusColor: statusHex(String(mesh.userData.status ?? "")),
              opacity,
            });
          }
        }

        setAmbientLabels(nextLabels);

        const nextLinkLabels: LinkLabel[] = [];
        if (selectedBodyId !== undefined) {
          for (const linkLine of linkLines) {
            if (!linkLine.label) {
              continue;
            }
            const isHighlighted = linkLine.sourceId === selectedBodyId || linkLine.targetId === selectedBodyId;
            if (!isHighlighted) {
              continue;
            }
            linkLine.sourceMesh.getWorldPosition(sourceWorld);
            linkLine.targetMesh.getWorldPosition(targetWorld);
            const midWorld = sourceWorld.clone().lerp(targetWorld, 0.5);
            midWorld.y += 0.5;
            const screen = worldToScreen(midWorld);
            if (screen.z < -1 || screen.z > 1) {
              continue;
            }
            nextLinkLabels.push({ id: `${linkLine.sourceId}-${linkLine.targetId}`, x: screen.x, y: screen.y, text: linkLine.label });
          }
        }
        setLinkLabels(nextLinkLabels);

        lastLabelUpdate = performance.now();
      }

      if (selectedMesh) {
        const selectedWorld = new THREE.Vector3();
        selectedMesh.getWorldPosition(selectedWorld);
        targetFocus.lerp(selectedWorld, 0.12);

        if (performance.now() - lastOverlayUpdate > 42) {
          const screen = worldToScreen(selectedWorld);
          const panelOnRight = screen.x < canvasHost.clientWidth * 0.52;
          const panelX = clamp(
            screen.x + (panelOnRight ? 112 : -288),
            10,
            Math.max(10, canvasHost.clientWidth - 256),
          );
          const panelY = clamp(screen.y - 92, 10, Math.max(10, canvasHost.clientHeight - 168));

          setContextPanel((current) => ({
            ...current,
            open: true,
            screenX: screen.x,
            screenY: screen.y,
            panelX,
            panelY,
            panelOnRight,
          }));
          lastOverlayUpdate = performance.now();
        }
      }

      const planarDistance = Math.max(0.25, Math.cos(cameraPitch) * cameraDistance);
      const verticalLift = Math.sin(cameraPitch) * cameraDistance;
      camera.position.x = cameraFocus.x + Math.cos(cameraYaw) * planarDistance;
      camera.position.z = cameraFocus.z + Math.sin(cameraYaw) * planarDistance;
      camera.position.y = cameraFocus.y + verticalLift + Math.sin(time * 0.7) * 0.35;
      camera.lookAt(cameraFocus);

      starField.rotation.y = time * 0.01;
      starField.rotation.x = time * 0.004;
      starMaterial.opacity = 0.75 + Math.sin(time * 1.8) * 0.07;
      nebulaA.rotation.y = -time * 0.006;
      nebulaA.rotation.z = Math.sin(time * 0.15) * 0.02;
      nebulaB.rotation.y = time * 0.004;
      nebulaB.rotation.x = Math.cos(time * 0.12) * 0.02;
      if (prettyMode) {
        renderBloomed();
      } else {
        renderer.render(scene, camera);
      }
      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrame);
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
      }
      resizeObserver.disconnect();
      starGeometry.dispose();
      starMaterial.dispose();
      nebulaA.geometry.dispose();
      (nebulaA.material as THREE.Material).dispose();
      nebulaB.geometry.dispose();
      (nebulaB.material as THREE.Material).dispose();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.removeEventListener("wheel", onWheel);
      window.removeEventListener(FOCUS_EVENT, onFocusEvent as EventListener);
      window.removeEventListener(RESET_EVENT, onResetEvent as EventListener);
      window.removeEventListener(RADIAL_ACTION_EVENT, onRadialActionEvent as EventListener);
      window.removeEventListener(BREADCRUMB_EVENT, onBreadcrumbEvent as EventListener);
      window.removeEventListener(SETTINGS_EVENT, onSettingsEvent as EventListener);
      window.removeEventListener("keydown", onKeyDown);
      setAmbientLabels([]);
      setLinkLabels([]);
      linkLines.forEach((linkLine) => {
        scene.remove(linkLine.line);
        linkLine.line.geometry.dispose();
        scene.remove(linkLine.antsLine);
        linkLine.antsLine.geometry.dispose();
      });
      mutedLinkMaterial.dispose();
      antsMaterial.dispose();
      groupRoot.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach((material) => material.dispose());
          } else {
            object.material.dispose();
          }
        }

        if (object instanceof THREE.LineLoop) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach((material) => material.dispose());
          } else {
            object.material.dispose();
          }
        }
      });
      bloomComposer.dispose();
      finalComposer.dispose();
      bloomDarkMaterial.dispose();
      renderer.dispose();
      canvasHost.removeChild(renderer.domElement);
    };
  }, [focusTargetKey, sceneData, links]);

  return (
    <div
      ref={hostRef}
      className={[
        "relative w-full overflow-hidden bg-[#010208]",
        viewportClassName ?? "h-[560px]",
      ].join(" ")}
    >
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full">
          {ambientLabels.map((label) => (
            <line
              key={label.id}
              x1={label.anchorX}
              y1={label.anchorY}
              x2={label.x}
              y2={label.y}
              stroke="rgba(255,255,255,0.28)"
              strokeWidth={1}
              opacity={label.opacity}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 z-10">
          {ambientLabels.map((label) => (
            <div
              key={label.id}
              className="absolute translate-y-[-50%] pl-1.5"
              style={{
                left: `${label.x}px`,
                top: `${label.y}px`,
                opacity: label.opacity,
              }}
            >
              <p className="flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-white/70">
                <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ backgroundColor: label.statusColor }} />
                <span>{label.name}</span>
                <span className="text-[9px] uppercase tracking-[0.16em] text-white/35">{label.type}</span>
              </p>
            </div>
          ))}
          {linkLabels.map((label) => (
            <div
              key={label.id}
              className="absolute -translate-x-1/2 -translate-y-full whitespace-nowrap text-[11px] font-medium text-cyan-100/90"
              style={{ left: `${label.x}px`, top: `${label.y - 4}px` }}
            >
              {label.text}
            </div>
          ))}
        </div>

        <div className="absolute bottom-3 left-3 z-20 flex items-center gap-1 rounded-full border border-cyan-100/15 bg-[#041226]/48 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-cyan-100/60 backdrop-blur transition-opacity hover:text-cyan-100/85 hover:opacity-100 opacity-55">
          {breadcrumb.map((crumb, index) => (
            <Fragment key={`${crumb.action}-${crumb.label}-${index}`}>
              {index > 0 ? <span className="pointer-events-none text-cyan-100/35">›</span> : null}
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent(BREADCRUMB_EVENT, { detail: crumb }))}
                className="pointer-events-auto transition hover:text-cyan-50"
              >
                {crumb.label}
              </button>
            </Fragment>
          ))}
        </div>

        {contextPanel.open ? (
          <>
            <div
              className="pointer-events-none absolute z-20 h-px origin-left"
              style={{
                backgroundColor: contextPanel.accent,
                left: `${contextPanel.screenX}px`,
                top: `${contextPanel.screenY}px`,
                width: `${Math.hypot(contextPanel.panelX - contextPanel.screenX, contextPanel.panelY - contextPanel.screenY)}px`,
                transform: `rotate(${Math.atan2(contextPanel.panelY - contextPanel.screenY, contextPanel.panelX - contextPanel.screenX)}rad)`,
                opacity: 0.72,
              }}
            />
            <span
              className="pointer-events-none absolute z-20 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(34,211,238,0.95)]"
              style={{
                backgroundColor: contextPanel.accent,
                left: `${contextPanel.screenX + (contextPanel.panelX - contextPanel.screenX) * leaderDotProgress}px`,
                top: `${contextPanel.screenY + (contextPanel.panelY - contextPanel.screenY) * leaderDotProgress}px`,
              }}
            />
            <div
              className="absolute z-30 w-64 rounded-lg border bg-[rgba(3,5,18,0.95)] px-2.5 py-2 text-cyan-50/90 shadow-[0_16px_35px_rgba(3,17,38,0.6)]"
              style={{
                left: `${contextPanel.panelX}px`,
                top: `${contextPanel.panelY}px`,
                borderColor: `${contextPanel.accent}66`,
              }}
            >
              <span className="pointer-events-none absolute left-0 top-0 h-3 w-3 border-l border-t" style={{ borderColor: contextPanel.accent, transform: "translate(-1px,-1px)" }} />
              <span className="pointer-events-none absolute right-0 top-0 h-3 w-3 border-r border-t" style={{ borderColor: contextPanel.accent, transform: "translate(1px,-1px)" }} />
              <span className="pointer-events-none absolute bottom-0 left-0 h-3 w-3 border-b border-l" style={{ borderColor: contextPanel.accent, transform: "translate(-1px,1px)" }} />
              <span className="pointer-events-none absolute bottom-0 right-0 h-3 w-3 border-b border-r" style={{ borderColor: contextPanel.accent, transform: "translate(1px,1px)" }} />
              <button
                type="button"
                onClick={() => setPanelOverflowOpen((value) => !value)}
                className="absolute right-2 top-2 rounded-full px-1.5 py-0.5 text-[14px] leading-none text-cyan-100/55 transition hover:bg-cyan-100/8 hover:text-cyan-50"
                aria-label="More actions"
              >
                ···
              </button>
              {panelOverflowOpen ? (
                <div className="absolute right-2 top-8 z-10 min-w-24 rounded-md border border-cyan-100/15 bg-[#061222]/96 p-1 shadow-[0_10px_22px_rgba(2,12,30,0.55)]">
                  <button
                    type="button"
                    onClick={() => {
                      setPanelOverflowOpen(false);
                      window.dispatchEvent(new CustomEvent(RADIAL_ACTION_EVENT, { detail: { id: "copy" } }));
                    }}
                    className="block w-full rounded px-2 py-1 text-left text-[10px] uppercase tracking-[0.14em] text-cyan-100/80 transition hover:bg-cyan-100/10 hover:text-cyan-50"
                  >
                    Copy key
                  </button>
                </div>
              ) : null}
              <p className="text-[9px] uppercase tracking-[0.26em] text-cyan-100/45">{contextPanel.categoryLabel}</p>
              <p className="mt-1 text-[15px] font-medium">{contextPanel.label}</p>
              <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                <span className="uppercase tracking-[0.14em] text-cyan-100/50">Status</span>
                <span className="inline-flex items-center gap-1.5 font-mono text-cyan-50/85"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: contextPanel.accent }} />{contextPanel.status || "—"}</span>
                {contextPanel.details.map((detail) => (
                  <Fragment key={detail.label}>
                    <span className="uppercase tracking-[0.14em] text-cyan-100/50">{detail.label}</span>
                    <span className="font-mono text-cyan-50/85">{detail.value}</span>
                  </Fragment>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-1.5">
                {contextActionsFor(selectedTier).map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent(RADIAL_ACTION_EVENT, { detail: { id: action.id } }))}
                    className={action.id === "dismiss"
                      ? "rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65 transition hover:bg-cyan-100/8 hover:text-cyan-50"
                      : "rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/90 transition hover:bg-cyan-100/12"}
                    style={action.id === "dismiss" ? undefined : { borderColor: `${contextPanel.accent}aa` }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {radialMenu.open ? (
          <>
            <button
              type="button"
              aria-label="Dismiss radial menu"
              onPointerDown={() => setRadialMenu((current) => ({ ...current, open: false }))}
              className="absolute inset-0 z-20"
            />
            <div
              className="pointer-events-none absolute z-30 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${radialMenu.centerX}px`,
                top: `${radialMenu.centerY}px`,
                backgroundColor: radialMenu.accent,
                boxShadow: `0 0 10px ${radialMenu.accent}cc`,
              }}
            />
            {radialPlacements.map((placement, index) => {
              const revealed = index < radialVisibleCount;
              return (
                <button
                  key={placement.action.id}
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent(RADIAL_ACTION_EVENT, { detail: { id: placement.action.id } }))}
                  className="absolute z-30 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-cyan-50/92 shadow-[0_8px_20px_rgba(2,12,30,0.45)] transition duration-160 ease-out"
                  style={{
                    left: `${placement.x}px`,
                    top: `${placement.y}px`,
                    borderColor: `${radialMenu.accent}aa`,
                    backgroundColor: "rgba(4,10,24,0.92)",
                    opacity: revealed ? 1 : 0,
                    transform: `translate(-50%, -50%) scale(${revealed ? 1 : 0.8})`,
                    transitionDelay: `${index * 25}ms`,
                  }}
                >
                  <span
                    className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[8px] font-semibold"
                    style={{ backgroundColor: `${radialMenu.accent}2e`, color: radialMenu.accent }}
                  >
                    {radialIcon(placement.action.id)}
                  </span>
                  <span>{placement.action.label}</span>
                </button>
              );
            })}
          </>
        ) : null}
    </div>
  );
}

export default UniverseCanvas;
