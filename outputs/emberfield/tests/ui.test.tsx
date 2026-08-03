/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dashboard } from "../app/page";
import { deriveConsoleAlerts } from "../app/hooks/use-dashboard";

const snapshot = {
  mode: "fixture",
  generatedAt: "2026-08-03T12:00:00.000Z",
  asset: {
    id: "demo-antelope-ranch",
    name: "Antelope Creek Ranch",
    location: { lat: 41.049033, lon: -116.543867 },
    radiusKm: 45,
  },
  detections: [],
  groups: [
    {
      cluster: {
        id: "cluster-1",
        centroid: { lat: 41.05, lon: -116.54 },
        detections: [],
        memberFingerprints: [],
        detectionCount: 3,
        firstAcquiredAt: "2026-08-03T08:00:00.000Z",
        latestAcquiredAt: "2026-08-03T11:30:00.000Z",
        satellites: ["NOAA-20", "NOAA-21"],
        maxConfidence: "high",
        maxFrpMw: 31.4,
      },
      weather: null,
      assessment: {
        assetId: "demo-antelope-ranch",
        clusterId: "cluster-1",
        score: 58,
        scoreRange: { low: 47, high: 67 },
        band: "elevated-context",
        contributions: [],
        reasons: [],
        missingInputs: ["weather", "air-quality"],
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
    nws: { mode: "fixture", status: "not-requested", source: "NWS", sourceUrl: null, fetchedAt: "2026-08-03T11:35:00.000Z", observedAt: null },
    airnow: { mode: "fixture", status: "missing-key", source: "AirNow", sourceUrl: null, fetchedAt: "2026-08-03T11:35:00.000Z", observedAt: null },
    wfigs: { mode: "fixture", status: "ok", source: "WFIGS", sourceUrl: null, fetchedAt: "2026-08-03T11:35:00.000Z", observedAt: "2026-08-03T11:10:00.000Z" },
  },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("EmberField console", () => {
  it("labels fixture evidence, limited inputs, freshness, and safety limits", () => {
    render(<Dashboard initialSnapshot={snapshot} />);

    expect(screen.getByText("Fixture data")).toBeTruthy();
    expect(screen.getAllByText("Limited data").length).toBeGreaterThan(0);
    expect(screen.getByText(/satellite-detected heat anomaly/i)).toBeTruthy();
    expect(screen.getByText(/approximately 375-meter VIIRS pixel/i)).toBeTruthy();
    expect(screen.getByText(/absence of detections does not mean absence of fire/i)).toBeTruthy();
    expect(screen.getByText(/informational context, not an evacuation or emergency-warning tool/i)).toBeTruthy();
    expect(screen.getAllByText("NASA FIRMS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("observed 11:30 UTC").length).toBeGreaterThan(0);
  });

  it("uses semantic mobile tabs without needing a WebGL map", () => {
    render(<Dashboard initialSnapshot={snapshot} />);

    expect(screen.getByRole("tablist", { name: "Console sections" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Assets" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Timeline" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Gemma" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Gemma" }));
    expect(screen.getByRole("tabpanel", { name: "Gemma" })).toBeTruthy();
  });

  it("submits an agriculture prompt and shows tolerant agent output", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/agent")) {
        return new Response(JSON.stringify({ answer: "Review the wind and official context before field work.", trace: [{ toolName: "inspect_asset", validatedArguments: { assetId: "demo-antelope-ranch" }, durationMs: 27, status: "ok", sourceStatus: { firms: "ok" }, resultSummary: { score: 58 } }] }), { status: 200 });
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: /brief me on this ranch/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(await screen.findByText(/review the wind and official context/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /visible tool trace/i }));
    expect(screen.getByText(/safe arguments.*demo-antelope-ranch/i)).toBeTruthy();
    expect(screen.getByText(/sources.*firms/i)).toBeTruthy();
    expect(screen.getByText(/result.*score/i)).toBeTruthy();
  });

  it("refreshes evidence when a saved asset is selected", async () => {
    const secondAsset = { id: "field-2", name: "Sierra Field", category: "field", location: { lat: 36.7, lon: -119.8 }, radiusKm: 25 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/assets") return new Response(JSON.stringify({ assets: [secondAsset] }), { status: 200 });
      return new Response(JSON.stringify({ ...snapshot, asset: secondAsset }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(await screen.findByRole("button", { name: /sierra field/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("name=Sierra+Field"),
    ));
  });

  it("shows one deduplicated fixture alert for a new activity group", () => {
    const alertSnapshot = {
      ...snapshot,
      groups: snapshot.groups.map((group) => ({
        ...group,
        assessment: { ...group.assessment, canAutomateAlerts: true },
      })),
    };
    const alerts = deriveConsoleAlerts(undefined, {
      ...alertSnapshot,
      groups: [...alertSnapshot.groups, ...alertSnapshot.groups],
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.dedupeKey).toBe("demo-antelope-ranch:cluster-1:new-cluster");
    render(<Dashboard initialSnapshot={alertSnapshot} />);
    expect(screen.getAllByText("New activity group").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/NASA FIRMS.*NOAA-20, NOAA-21/i).length).toBeGreaterThan(0);
  });
});
