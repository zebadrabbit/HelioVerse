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
    setPixelRatio() {}
    setSize() {}
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
  // @ts-expect-error jsdom does not implement ResizeObserver
  global.ResizeObserver = FakeResizeObserver;
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
});
