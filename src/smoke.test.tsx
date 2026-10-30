import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DashboardLayout } from "./dashboard-layout";
import { UniverseCanvas, type Body, type Link } from "./universe-canvas";

// jsdom has no WebGL; swap in a no-op renderer so mounting doesn't touch a real GL context.
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();

  class FakeWebGLRenderer {
    domElement = document.createElement("canvas");
    outputColorSpace = actual.SRGBColorSpace;
    toneMapping = actual.ACESFilmicToneMapping;
    toneMappingExposure = 1;
    // EffectComposer/UnrealBloomPass are constructed unconditionally and poke these on setup.
    shadowMap = { enabled: false, type: actual.PCFSoftShadowMap };
    capabilities = { isWebGL2: true, maxTextureSize: 4096 };
    autoClear = true;
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    getSize(target: { set(w: number, h: number): unknown }) { return target.set(1, 1); }
    getContext() { return {}; }
    setRenderTarget() {}
    getRenderTarget() { return null; }
    setClearColor() {}
    getClearColor(target: unknown) { return target; }
    getClearAlpha() { return 1; }
    setClearAlpha() {}
    clear() {}
    clearDepth() {}
    render() {}
    dispose() {}
  }

  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

beforeAll(() => {
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = FakeResizeObserver;
  // jsdom logs a loud "not implemented" error for canvas 2D contexts; the texture code already
  // treats a null context as "skip the map", so make that the quiet path.
  HTMLCanvasElement.prototype.getContext = () => null;
});

afterEach(() => {
  cleanup();
});

const bodies: Body[] = [
  { id: "star-1", type: "star", label: "Origin", color: "#ffcc66", scale: 0.8, relevance: 1 },
  { id: "planet-1", type: "character", label: "Protagonist", color: "#66ccff", scale: 0.5, relevance: 0.6, parentId: "star-1", status: "active" },
  { id: "moon-1", type: "plot", label: "Subplot", color: "#99ff99", scale: 0.3, relevance: 0.4, parentId: "planet-1" },
];

const links: Link[] = [{ id: "link-1", sourceId: "planet-1", targetId: "moon-1", label: "involves" }];

describe("UniverseCanvas", () => {
  it("renders a tiny Body/Link dataset without throwing", () => {
    expect(() => render(<UniverseCanvas bodies={bodies} links={links} />)).not.toThrow();
  });

  it("renders with an empty dataset without throwing", () => {
    expect(() => render(<UniverseCanvas bodies={[]} />)).not.toThrow();
  });

  it("treats an unknown body type as a generic planet without erroring", () => {
    const weirdBodies: Body[] = [
      { id: "root", type: "hub", label: "Hub", color: "#ffffff", scale: 0.5, relevance: 1 },
      { id: "mystery", type: "something-nobody-heard-of", label: "Mystery", color: "#ff00ff", scale: 0.5, relevance: 0.5, parentId: "root" },
    ];
    expect(() => render(<UniverseCanvas bodies={weirdBodies} />)).not.toThrow();
  });
});

describe("DashboardLayout", () => {
  it("renders the window shell without throwing", () => {
    expect(() =>
      render(
        <DashboardLayout leftPanel={<div>left</div>} rightPanel={<div>right</div>} mainPanel={<div>main</div>} />,
      ),
    ).not.toThrow();
  });

  it("opens the Comms window beside the panels when a notification arrives", () => {
    const notifications = [{ id: "n1", text: "hello", tone: "info" as const, timestamp: new Date().toISOString() }];
    const { getByText } = render(
      <DashboardLayout leftPanel={<div>left</div>} rightPanel={<div>right</div>} mainPanel={<div>main</div>} notifications={notifications} />,
    );
    expect(getByText("Comms")).toBeTruthy();
    expect(getByText("left")).toBeTruthy();
    expect(getByText("right")).toBeTruthy();
  });
});
