/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DashboardSnapshot } from "../app/hooks/use-dashboard";
import { Dashboard } from "../app/page";

// Every fixture below shares one geometry: the detection cluster sits about
// 33.5 km due east of the saved asset, so the bearing from the smoke source to
// the asset is ~270 degrees and the asset is well inside its own 45 km radius.
// Only the wind changes between cases, because wind is the single input that
// decides which arrival status estimateSmokeArrival returns.
const assetLocation = { lat: 41.049033, lon: -116.543867 };
const sourceLocation = { lat: 41.049033, lon: -116.143867 };

const detections = [
  { id: "detection-1", lat: 41.0488, lon: -116.1442, acquiredAt: "2026-08-03T09:00:00.000Z", satellite: "NOAA-20", confidence: "nominal", frpMw: 14.2 },
  { id: "detection-2", lat: 41.0492, lon: -116.1436, acquiredAt: "2026-08-03T11:30:00.000Z", satellite: "NOAA-21", confidence: "high", frpMw: 31.4 },
];

type GroupWeather = DashboardSnapshot["groups"][number]["weather"];

/**
 * Wind blowing from 090 pushes smoke toward 270, straight down the source to
 * asset bearing. 8 m/s over 33.5 km is 1.2 h of raw advection, corrected to
 * 2.6 h, which lands 2.1 h after the 12:00Z snapshot instant.
 */
const downwindWeather: GroupWeather = {
  windSpeedMps: 8,
  windFromDeg: 90,
  relativeHumidityPct: 18,
  quality: "direct-fresh",
  observedAt: "2026-08-03T11:00:00.000Z",
};

function snapshotWithWeather(weather: GroupWeather): DashboardSnapshot {
  return {
    mode: "fixture",
    generatedAt: "2026-08-03T12:00:00.000Z",
    asset: {
      id: "demo-antelope-ranch",
      name: "Antelope Creek Ranch",
      location: assetLocation,
      radiusKm: 45,
    },
    detections,
    groups: [
      {
        cluster: {
          id: "cluster-1",
          centroid: sourceLocation,
          detections,
          memberFingerprints: ["detection-1", "detection-2"],
          detectionCount: 2,
          firstAcquiredAt: "2026-08-03T09:00:00.000Z",
          latestAcquiredAt: "2026-08-03T11:30:00.000Z",
          satellites: ["NOAA-20", "NOAA-21"],
          maxConfidence: "high",
          maxFrpMw: 31.4,
        },
        weather,
        assessment: {
          score: 58,
          scoreRange: { low: 47, high: 67 },
          band: "elevated-context",
          contributions: [
            { code: "distance", label: "Distance to asset", weight: 0.25, normalizedValue: 0.9, quality: 1, weightedValue: 0.225, available: true },
            { code: "air-quality", label: "Air quality", weight: 0.07, normalizedValue: null, quality: 0, weightedValue: 0, available: false },
          ],
          reasons: [{ code: "distance", label: "Distance to asset", contribution: 0.225 }],
          missingInputs: ["air-quality"],
          completeness: "partial",
          dataQuality: "limited",
          dataConfidence: 54,
          canAutomateAlerts: false,
        },
        officialMatch: null,
      },
    ],
    incidents: [],
    perimeters: [],
    air: null,
    sources: {
      firms: { mode: "fixture", status: "ok", source: "NASA FIRMS", sourceUrl: null, fetchedAt: "2026-08-03T11:35:00.000Z", observedAt: "2026-08-03T11:30:00.000Z" },
      nws: { mode: "fixture", status: "ok", source: "NWS", sourceUrl: null, fetchedAt: "2026-08-03T11:35:00.000Z", observedAt: "2026-08-03T10:00:00.000Z" },
      airnow: { mode: "fixture", status: "missing-key", source: "AirNow", sourceUrl: null, fetchedAt: "2026-08-03T11:35:00.000Z", observedAt: null },
      wfigs: { mode: "fixture", status: "ok", source: "WFIGS", sourceUrl: null, fetchedAt: "2026-08-03T11:35:00.000Z", observedAt: "2026-08-03T11:10:00.000Z" },
    },
  };
}

/** Transport bearing 270, 0 degrees off axis: inbound at moderate confidence. */
const inboundSnapshot = snapshotWithWeather(downwindWeather);
/** Wind rotated 180 degrees: transport runs away from the asset. */
const offPlumeSnapshot = snapshotWithWeather({ ...downwindWeather, windFromDeg: 270 });
/** Transport bearing 310: still inbound, but 40 degrees off the plume axis. */
const wideAngleSnapshot = snapshotWithWeather({ ...downwindWeather, windFromDeg: 130 });
/** Below the 1 m/s floor where a transport direction means anything. */
const calmWindSnapshot = snapshotWithWeather({ ...downwindWeather, windSpeedMps: 0.4 });
/** No weather at all, so both wind inputs are absent rather than zero. */
const missingWeatherSnapshot = snapshotWithWeather(null);

const health = {
  status: "degraded" as const,
  integrations: {
    firms: { configured: true, status: "ready" as const },
    airnow: { configured: false, status: "missing-key" as const },
    ollama: { configured: true, status: "offline" as const },
  },
};

function backgroundResponse(input: RequestInfo | URL) {
  if (String(input) === "/api/assets") return new Response(JSON.stringify({ assets: [] }), { status: 200 });
  if (String(input) === "/api/health") return new Response(JSON.stringify(health), { status: 200 });
  return new Response(JSON.stringify(inboundSnapshot), { status: 200 });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => backgroundResponse(input)));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The inspector is mounted twice — once in the desktop workspace and once in
 * the mobile Activity tabpanel — so both copies have to agree.
 */
function arrivalBlocks(): HTMLElement[] {
  const blocks = screen.getAllByLabelText("Smoke arrival estimate");
  expect(blocks).toHaveLength(2);
  return blocks;
}

/**
 * jsdom has no WebGL, so MapCanvas always renders its non-map fallback and no
 * MapLibre source or layer exists. The HUD and captions render in both
 * branches, which is why the map assertions live there.
 */
async function mapHud(): Promise<HTMLElement> {
  return waitFor(() => {
    const hud = document.querySelector<HTMLElement>(".map-hud");
    if (!hud) throw new Error("The evidence map HUD has not rendered yet.");
    return hud;
  });
}

const confidenceChip = (block: HTMLElement) => within(block).getByText(/\bconfidence$/);

const confidenceCases: Array<[string, DashboardSnapshot, string]> = [
  ["an inbound plume", inboundSnapshot, "moderate"],
  ["a 40 degree off-axis inbound plume", wideAngleSnapshot, "low"],
  ["an off-plume asset", offPlumeSnapshot, "low"],
  ["calm wind", calmWindSnapshot, "none"],
  ["missing weather", missingWeatherSnapshot, "none"],
];

describe("EmberField smoke arrival", () => {
  it("states the arrival hours, the estimated arrival line, and a map chip when smoke is inbound", async () => {
    render(<Dashboard initialSnapshot={inboundSnapshot} />);

    for (const block of arrivalBlocks()) {
      expect(block.className).toContain("inbound");
      expect(within(block).getByText("2.1 h")).toBeTruthy();
      expect(within(block).getByText(/^Estimated arrival 2026-08-03T14:03:5\d(\.\d{3})?Z · transit time 2\.6 h$/)).toBeTruthy();
    }
    expect(within(await mapHud()).getByText("Smoke in 2.1 h")).toBeTruthy();
  });

  it("keeps the inbound arrival inside the validated envelope it claims", async () => {
    render(<Dashboard initialSnapshot={inboundSnapshot} />);

    for (const block of arrivalBlocks()) {
      // Hours are forward-looking from the snapshot instant, never negative
      // and never a placeholder zero.
      const hours = Number(/^(\d+(?:\.\d)?) h$/.exec(within(block).getByText(/^\d+(\.\d)? h$/).textContent ?? "")?.[1]);
      expect(hours).toBeGreaterThan(0);
      expect(Number.isFinite(hours)).toBe(true);
    }
    // 33.5 km sits inside both the 45 km asset radius and the validated envelope.
    expect(screen.getAllByText("33.5 km")).toHaveLength(2);
    expect(within(await mapHud()).getByText("toward asset, 0° offset")).toBeTruthy();
  });

  it("shows the quiet not-upwind copy and claims no arrival hour when the wind is reversed", async () => {
    render(<Dashboard initialSnapshot={offPlumeSnapshot} />);

    for (const block of arrivalBlocks()) {
      expect(block.className).toContain("off-plume");
      expect(within(block).getByText("Not upwind")).toBeTruthy();
      expect(within(block).getByText("180° off the transport bearing")).toBeTruthy();
      expect(block.textContent).not.toMatch(/Estimated arrival/);
      expect(block.textContent).not.toMatch(/\d+(\.\d+)?\s*h\b/);
    }
    expect(within(await mapHud()).getByText("Not upwind of asset")).toBeTruthy();
    expect(screen.queryByText(/Smoke in \d/)).toBeNull();
  });

  it("names the missing wind inputs instead of defaulting the arrival to a number", async () => {
    render(<Dashboard initialSnapshot={missingWeatherSnapshot} />);

    for (const block of arrivalBlocks()) {
      expect(block.className).toContain("insufficient-data");
      expect(within(block).getByText("Unassessable")).toBeTruthy();
      expect(within(block).getByText("Missing: wind-speed, wind-direction")).toBeTruthy();
      // No number of any kind: an absent input is never rendered as zero.
      expect(block.textContent).not.toMatch(/\d/);
    }
    expect(within(await mapHud()).getByText("Arrival not assessable")).toBeTruthy();
    expect(screen.getAllByText("Missing weather")).toHaveLength(2);
  });

  it("reports calm wind rather than a transit time below the 1 m/s floor", async () => {
    render(<Dashboard initialSnapshot={calmWindSnapshot} />);

    for (const block of arrivalBlocks()) {
      expect(block.className).toContain("calm-wind");
      expect(within(block).getByText("Calm wind")).toBeTruthy();
      expect(block.textContent).not.toMatch(/Estimated arrival/);
      expect(block.textContent).not.toMatch(/\d+(\.\d+)?\s*h\b/);
    }
    expect(within(await mapHud()).getByText("Wind too calm to track")).toBeTruthy();
    expect(screen.queryByText(/Smoke in \d/)).toBeNull();
  });

  it("repeats the fire-spread disclaimer on the map while smoke is inbound", async () => {
    render(<Dashboard initialSnapshot={inboundSnapshot} />);
    await mapHud();

    // Two inspector copies plus the inbound-only map caption.
    expect(screen.getAllByText(/does not predict where the fire itself will go/i)).toHaveLength(3);
    expect(screen.getByText("Smoke-transport estimate only. It does not predict where the fire itself will go.").className)
      .toContain("arrival-caption");
    for (const block of arrivalBlocks()) {
      expect(within(block).getByText("Smoke-transport estimate from measured wind. It does not predict where the fire itself will go.")).toBeTruthy();
    }
  });

  it("drops the inbound map caption when no smoke is heading to the asset", async () => {
    render(<Dashboard initialSnapshot={offPlumeSnapshot} />);
    await mapHud();

    expect(document.querySelector(".arrival-caption")).toBeNull();
    // The inspector keeps its own disclaimer in every status.
    expect(screen.getAllByText(/does not predict where the fire itself will go/i)).toHaveLength(2);
  });

  it.each(confidenceCases)("caps the arrival confidence chip at moderate for %s", (_label, fixture, expected) => {
    render(<Dashboard initialSnapshot={fixture} />);

    for (const block of arrivalBlocks()) {
      const chip = confidenceChip(block);
      expect(chip.textContent).toBe(`${expected} confidence`);
      expect(chip.className).toContain(`confidence-${expected}`);
      expect(chip.className).not.toContain("confidence-high");
      expect(chip.textContent).not.toMatch(/high|certain|guaranteed/i);
    }
  });
});
