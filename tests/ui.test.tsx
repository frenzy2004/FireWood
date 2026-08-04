/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentPanel } from "../app/components/AgentPanel";
import { SetupPanel } from "../app/components/SetupPanel";
import { applyReplayState, FULL_REPLAY_STATE } from "../app/components/TimelineDock";
import { type DashboardSnapshot, deriveConsoleAlerts } from "../app/hooks/use-dashboard";
import { Dashboard } from "../app/page";

const detections = [
  { id: "detection-1", lat: 41.05, lon: -116.54, acquiredAt: "2026-08-03T09:00:00.000Z", satellite: "NOAA-20", confidence: "nominal", frpMw: 14.2 },
  { id: "detection-2", lat: 41.051, lon: -116.541, acquiredAt: "2026-08-03T11:30:00.000Z", satellite: "NOAA-21", confidence: "high", frpMw: 31.4 },
];

const snapshot: DashboardSnapshot = {
  mode: "fixture",
  generatedAt: "2026-08-03T12:00:00.000Z",
  asset: {
    id: "demo-antelope-ranch",
    name: "Antelope Creek Ranch",
    location: { lat: 41.049033, lon: -116.543867 },
    radiusKm: 45,
  },
  detections,
  groups: [
    {
      cluster: {
        id: "cluster-1",
        centroid: { lat: 41.05, lon: -116.54 },
        detections,
        memberFingerprints: ["detection-1", "detection-2"],
        detectionCount: 2,
        firstAcquiredAt: "2026-08-03T09:00:00.000Z",
        latestAcquiredAt: "2026-08-03T11:30:00.000Z",
        satellites: ["NOAA-20", "NOAA-21"],
        maxConfidence: "high",
        maxFrpMw: 31.4,
      },
      weather: {
        windSpeedMps: 6.1,
        windFromDeg: 235,
        relativeHumidityPct: 22,
        quality: "direct-fresh",
        observedAt: "2026-08-03T10:00:00.000Z",
      },
      assessment: {
        assetId: "demo-antelope-ranch",
        clusterId: "cluster-1",
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

const health = {
  status: "degraded" as const,
  integrations: {
    firms: { configured: true, status: "ready" as const },
    airnow: { configured: false, status: "missing-key" as const },
    ollama: { configured: true, status: "offline" as const },
  },
};

const virtualSnapshotResponse = () => ({
  ...snapshot,
  snapshotId: null,
  persisted: false,
  alerts: [],
  history24h: {
    since: "2026-08-02T12:00:00.000Z",
    runs: [],
    detections: [],
    alerts: [],
  },
});

function backgroundResponse(input: RequestInfo | URL) {
  if (String(input) === "/api/assets") return new Response(JSON.stringify({ assets: [] }), { status: 200 });
  if (String(input) === "/api/health") return new Response(JSON.stringify(health), { status: 200 });
  return new Response(JSON.stringify(snapshot), { status: 200 });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => backgroundResponse(input)));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EmberField console", () => {
  it("labels the displayed fixture snapshot, full freshness, and permanent safety limits", async () => {
    render(<Dashboard initialSnapshot={snapshot} />);

    expect(screen.getByText("Showing fixture snapshot")).toBeTruthy();
    expect(screen.getAllByText("Limited data").length).toBeGreaterThan(0);
    expect(screen.getByText(/satellite-detected heat anomaly/i)).toBeTruthy();
    expect(screen.getByText(/approximately 375-meter VIIRS pixel/i)).toBeTruthy();
    expect(screen.getByText(/points do not measure burning acreage/i)).toBeTruthy();
    expect(screen.getByText(/not for evacuation, dispatch, firefighting/i)).toBeTruthy();
    expect(screen.getByText(/follow local emergency officials and NWS alerts/i)).toBeTruthy();
    expect(screen.getAllByText(/observed 2026-08-03T11:30:00Z/i).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText(/Ollama offline/i)).toBeTruthy());
  });

  it("keeps the fixture mode active and discloses retained fixture evidence after live failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/snapshot" && JSON.parse(String(init?.body)).mode === "live") {
        return new Response(JSON.stringify({ error: "Live snapshot unavailable" }), { status: 502 });
      }
      return backgroundResponse(input);
    }));
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Live data" }));

    expect(await screen.findByText(/showing the previous fixture snapshot/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fixture data" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Live data" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Showing fixture snapshot")).toBeTruthy();
  });

  it("uses the normalized Census match and reports a no-match without clearing entries", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "ok",
      match: { location: { lat: 38.123, lon: -121.456 } },
      mode: "live",
      source: "US Census Geocoder",
      fetchedAt: "2026-08-03T12:00:00.000Z",
    }), { status: 200 })));
    const { rerender } = render(<SetupPanel onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Address lookup"), { target: { value: "100 Farm Road" } });
    fireEvent.click(screen.getByRole("button", { name: "Lookup" }));
    await waitFor(() => expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("38.123"));
    expect((screen.getByLabelText("Longitude") as HTMLInputElement).value).toBe("-121.456");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "no-match", match: null }), { status: 200 })));
    rerender(<SetupPanel onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Lookup" }));
    expect(await screen.findByText(/no census coordinate match/i)).toBeTruthy();
    expect((screen.getByLabelText("Address lookup") as HTMLInputElement).value).toBe("100 Farm Road");
  });

  it("does not apply a Census response after the address has changed", async () => {
    let resolveLookup: ((response: Response) => void) | undefined;
    let lookupSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      void input;
      lookupSignal = init?.signal ?? undefined;
      resolveLookup = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupPanel onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Address lookup"), { target: { value: "100 Farm Road" } });
    fireEvent.click(screen.getByRole("button", { name: "Lookup" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Address lookup"), { target: { value: "200 Orchard Lane" } });

    expect(lookupSignal?.aborted).toBe(true);
    await act(async () => {
      resolveLookup?.(new Response(JSON.stringify({
        status: "ok",
        match: { location: { lat: 38.123, lon: -121.456 } },
      }), { status: 200 }));
    });
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Longitude") as HTMLInputElement).value).toBe("");
  });

  it("scrubs exact raw detections and synchronizes the map count and inspector", async () => {
    render(<Dashboard initialSnapshot={snapshot} />);
    expect(screen.getByText("2 raw detections")).toBeTruthy();
    expect(screen.getAllByText("2 detected points").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Timeline position"), { target: { value: "21" } });

    await waitFor(() => expect(screen.getByText("1 raw detection")).toBeTruthy());
    expect(screen.getAllByText("1 detected point").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Replay cutoff 2026-08-03T09:00:00Z/i).length).toBeGreaterThan(0);
  });

  it("uses the replay cutoff as snapshot time and hides the latest assessment", () => {
    const cutoff = "2026-08-03T09:00:00.000Z";
    const replayed = applyReplayState(snapshot, {
      cutoff,
      sources: { firms: true, nws: true, airnow: true },
    });

    expect(replayed?.generatedAt).toBe(cutoff);
    expect(replayed?.groups[0]?.cluster.detectionCount).toBe(1);
    expect(replayed?.groups[0]?.assessment.score).toBeNull();
    expect(replayed?.groups[0]?.assessment.contributions).toEqual([]);
  });

  it("hides source freshness timestamps that occur after a replay cutoff", () => {
    const replayed = applyReplayState(snapshot, {
      cutoff: "2026-08-03T09:00:00.000Z",
      sources: { firms: true, nws: true, airnow: true },
    });

    expect(replayed?.sources.firms?.observedAt).toBe("2026-08-03T09:00:00.000Z");
    expect(replayed?.sources.firms?.fetchedAt).toBeNull();
    expect(replayed?.sources.nws?.observedAt).toBeNull();
    expect(replayed?.sources.nws?.fetchedAt).toBeNull();
  });

  it("preserves complete source freshness when the replay is at now", () => {
    const liveSnapshot = {
      ...snapshot,
      mode: "live" as const,
      sources: {
        ...snapshot.sources,
        firms: {
          ...snapshot.sources.firms,
          mode: "live" as const,
          fetchedAt: "2026-08-03T12:00:01.000Z",
        },
      },
    };

    const replayed = applyReplayState(liveSnapshot, FULL_REPLAY_STATE);

    expect(replayed?.sources.firms?.fetchedAt)
      .toBe("2026-08-03T12:00:01.000Z");
    expect(replayed?.sources.firms?.replayState).toBe("included");
  });

  it("shows health statuses, last refresh, and the agent offline state", async () => {
    render(<Dashboard initialSnapshot={snapshot} />);

    await waitFor(() => expect(screen.getByText(/FIRMS ready/i)).toBeTruthy());
    expect(screen.getByText(/AirNow missing key/i)).toBeTruthy();
    expect(screen.getByText(/Ollama offline/i)).toBeTruthy();
    expect(screen.getByText(/Last refresh 2026-08-03T12:00:00Z/i)).toBeTruthy();
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });

  it("posts only the virtual asset identity and keeps its non-persistence visible", async () => {
    const snapshotCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/snapshot") {
        snapshotCalls.push([input, init]);
        return new Response(JSON.stringify(virtualSnapshotResponse()), { status: 200 });
      }
      return backgroundResponse(input);
    }));
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }));

    await waitFor(() => expect(snapshotCalls).toHaveLength(1));
    const [url, init] = snapshotCalls[0];
    expect(String(url)).toBe("/api/snapshot");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      assetId: "demo-antelope-ranch",
      mode: "fixture",
      refresh: true,
    });
    expect(String(init?.body)).not.toMatch(/latitude|longitude|radius|name|lat|lon/i);
    expect(await screen.findByText(/Virtual demo · not persisted/i)).toBeTruthy();
    expect(screen.queryByText(/Saved locally/i)).toBeNull();
  });

  it("hydrates bounded saved history and server alerts without duplicate evidence", async () => {
    const secondAsset = { id: "field-2", name: "Sierra Field", category: "field", location: { lat: 36.7, lon: -119.8 }, radiusKm: 25 };
    const historicDetection = { id: "detection-history", lat: 36.71, lon: -119.81, acquiredAt: "2026-08-03T08:00:00.000Z", satellite: "Suomi NPP", confidence: "nominal", frpMw: 10.2 };
    const currentDetection = { ...detections[1], lat: 36.705, lon: -119.805 };
    const persistedAlert = {
      id: "alert-history",
      type: "new-cluster" as const,
      assetId: secondAsset.id,
      clusterId: "historic-track",
      dedupeKey: "field-2:live:historic-track:new-cluster",
      createdAt: "2026-08-03T08:05:00.000Z",
      updatedAt: "2026-08-03T08:05:00.000Z",
      message: "Persisted activity first appeared near this field.",
      acquiredAt: historicDetection.acquiredAt,
      distanceKm: 1.6,
      confidence: historicDetection.confidence,
      source: "NASA FIRMS: Suomi NPP",
    };
    const savedResponse = {
      ...snapshot,
      mode: "live" as const,
      generatedAt: "2026-08-03T12:15:00.000Z",
      asset: secondAsset,
      detections: [currentDetection],
      groups: snapshot.groups.map((group) => ({
        ...group,
        cluster: {
          ...group.cluster,
          id: "current-track",
          centroid: { lat: currentDetection.lat, lon: currentDetection.lon },
          detections: [currentDetection],
          memberFingerprints: [currentDetection.id],
          detectionCount: 1,
          firstAcquiredAt: currentDetection.acquiredAt,
          latestAcquiredAt: currentDetection.acquiredAt,
          satellites: [currentDetection.satellite],
        },
      })),
      snapshotId: "run-2",
      persisted: true,
      alerts: [],
      history24h: {
        since: "2026-08-02T12:15:00.000Z",
        runs: [
          { id: "run-2", generatedAt: "2026-08-03T12:15:00.000Z", detectionCount: 1, groupCount: 1 },
          { id: "run-1", generatedAt: "2026-08-03T08:05:00.000Z", detectionCount: 1, groupCount: 1 },
        ],
        detections: [currentDetection, historicDetection, historicDetection],
        alerts: [persistedAlert, persistedAlert],
      },
      sources: Object.fromEntries(Object.entries(snapshot.sources).map(([key, source]) => [key, { ...source, mode: "live" }])),
    };
    const snapshotBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/assets") return new Response(JSON.stringify({ assets: [secondAsset] }), { status: 200 });
      if (String(input) === "/api/health") return new Response(JSON.stringify(health), { status: 200 });
      if (String(input) === "/api/snapshot") {
        snapshotBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(savedResponse), { status: 200 });
      }
      return backgroundResponse(input);
    }));
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(await screen.findByRole("button", { name: /sierra field/i }));

    await waitFor(() => expect(snapshotBodies).toEqual([{ assetId: "field-2", mode: "live", refresh: true }]));
    expect(await screen.findByText(/Saved locally · 2\/48 runs · 2\/2,000 detections · 1\/200 alerts/i)).toBeTruthy();
    expect(screen.getByText("2 raw detections")).toBeTruthy();
    for (const feed of screen.getAllByLabelText("In-console alerts")) {
      expect(within(feed).getAllByText("Persisted activity first appeared near this field.")).toHaveLength(1);
      expect(feed.textContent).toMatch(/2026-08-03T08:00:00Z.*1\.6 km.*nominal.*NASA FIRMS: Suomi NPP/i);
    }
    expect(screen.getAllByLabelText(/Suomi NPP detection at 2026-08-03T08:00:00Z/i)).toHaveLength(1);
  });

  it.each([
    [429, "Another local snapshot refresh is already running", "Refresh limited", { "Retry-After": "1" }],
    [503, "Local snapshot persistence is unavailable", "Local snapshot unavailable", {}],
  ])("retains displayed evidence after a %s snapshot failure", async (status, message, heading, headers) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/snapshot") {
        return new Response(JSON.stringify({ error: message }), { status, headers });
      }
      return backgroundResponse(input);
    }));
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }));

    expect(await screen.findByText(new RegExp(heading, "i"))).toBeTruthy();
    expect(screen.getByText(new RegExp(message, "i"))).toBeTruthy();
    expect(screen.getByText(/Showing the previous fixture snapshot for Antelope Creek Ranch/i)).toBeTruthy();
    if (status === 429) expect(screen.getByText(/Retry after 1 second/i)).toBeTruthy();
    expect(screen.getByText("2 raw detections")).toBeTruthy();
  });

  it("replaces stale ready badges when a later health probe fails", async () => {
    let healthCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/assets") return new Response(JSON.stringify({ assets: [] }), { status: 200 });
      if (String(input) === "/api/health") {
        healthCalls += 1;
        return healthCalls === 1
          ? new Response(JSON.stringify(health), { status: 200 })
          : new Response(JSON.stringify({ error: "probe failed" }), { status: 503 });
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }));
    render(<Dashboard initialSnapshot={snapshot} />);
    await screen.findByText(/FIRMS ready/i);

    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }));

    await waitFor(() => expect(screen.getByText(/FIRMS error/i)).toBeTruthy());
    expect(screen.queryByText(/FIRMS ready/i)).toBeNull();
    expect(screen.getByText(/Ollama error/i)).toBeTruthy();
  });

  it("uses keyboard-complete responsive tabs with stable controlled panels", () => {
    render(<Dashboard initialSnapshot={snapshot} />);
    const activity = screen.getByRole("tab", { name: "Activity" });
    const timeline = screen.getByRole("tab", { name: "Timeline" });

    expect((document.getElementById("panel-assets") as HTMLElement).hidden).toBe(true);
    expect(screen.getByRole("tabpanel", { name: "Activity" })).toBeTruthy();
    expect(activity.getAttribute("tabindex")).toBe("0");
    expect(timeline.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(activity, { key: "ArrowRight" });
    expect(timeline.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(timeline);
    expect(screen.getByRole("tabpanel", { name: "Timeline" })).toBeTruthy();
  });

  it("keeps exactly one controlled timeline when its responsive tab opens", async () => {
    render(<Dashboard initialSnapshot={snapshot} />);
    expect(screen.getAllByLabelText("Timeline position")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getAllByLabelText("Timeline position")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Timeline position"), { target: { value: "21" } });
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    await waitFor(() => expect((screen.getByLabelText("Timeline position") as HTMLInputElement).value).toBe("21"));
  });

  it("submits the saved asset identity and shows route status plus a tolerant trace", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/agent")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ assetId: "demo-antelope-ranch", mode: "fixture" });
        return new Response(JSON.stringify({ status: "grounding-error", answer: "Review deterministic evidence while grounding is unavailable.", model: "gemma4:12b", trace: [{ toolName: "inspect_asset", validatedArguments: { assetId: "demo-antelope-ranch" }, durationMs: 27, status: "ok", sourceStatus: { firms: { status: "ok", fetchedAt: "2026-08-03T11:35:00.000Z" } }, resultSummary: { score: 58 } }] }), { status: 200 });
      }
      return backgroundResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: /when would smoke reach here/i }));
    expect(await screen.findByText(/review deterministic evidence/i)).toBeTruthy();
    expect(screen.getByText("Grounding error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /visible tool trace/i }));
    expect(screen.getByText(/safe arguments.*demo-antelope-ranch/i)).toBeTruthy();
    expect(screen.getByText(/sources.*fetchedAt/i)).toBeTruthy();
  });

  it("refreshes evidence when a saved asset is selected", async () => {
    const secondAsset = { id: "field-2", name: "Sierra Field", category: "field", location: { lat: 36.7, lon: -119.8 }, radiusKm: 25 };
    const agentBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/assets") return new Response(JSON.stringify({ assets: [secondAsset] }), { status: 200 });
      if (String(input) === "/api/health") return new Response(JSON.stringify(health), { status: 200 });
      if (String(input) === "/api/agent") {
        agentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ status: "ok", answer: "Saved asset identity received.", model: "gemma4:12b", trace: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ...snapshot,
        mode: "live",
        asset: secondAsset,
        sources: Object.fromEntries(Object.entries(snapshot.sources).map(([key, source]) => [key, { ...source, mode: "live" }])),
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(await screen.findByRole("button", { name: /sierra field/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === "/api/snapshot" && JSON.parse(String(init?.body)).assetId === "field-2")).toBe(true));
    expect((await screen.findAllByText("Sierra Field")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /when would smoke reach here/i }));
    await waitFor(() => expect(agentBodies).toContainEqual(expect.objectContaining({ assetId: "field-2", mode: "live" })));
  });

  it("does not compare fixture and live scores as an asset trend", async () => {
    const liveSnapshot: DashboardSnapshot = {
      ...snapshot,
      mode: "live",
      generatedAt: "2026-08-03T13:00:00.000Z",
      groups: snapshot.groups.map((group) => ({
        ...group,
        assessment: { ...group.assessment, score: 68 },
      })),
      sources: Object.fromEntries(Object.entries(snapshot.sources).map(([key, source]) => [key, { ...source, mode: "live" }])),
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/assets") return new Response(JSON.stringify({ assets: [] }), { status: 200 });
      if (String(input) === "/api/health") return new Response(JSON.stringify(health), { status: 200 });
      return new Response(JSON.stringify(liveSnapshot), { status: 200 });
    }));
    render(<Dashboard initialSnapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Live data" }));

    await screen.findByText("Showing live snapshot");
    expect(screen.getByText(/Score 68.*new snapshot.*live.*2026-08-03T13:00:00Z/i)).toBeTruthy();
    expect(screen.queryByText(/Score 68.*up trend/i)).toBeNull();
  });

  it("derives every eligible alert family once with complete operator content", () => {
    const previous: DashboardSnapshot = {
      ...snapshot,
      generatedAt: "2026-08-03T04:00:00.000Z",
      groups: snapshot.groups.map((group) => ({
        ...group,
        cluster: { ...group.cluster, latestAcquiredAt: "2026-08-03T03:00:00.000Z", satellites: ["NOAA-20"] },
        assessment: { ...group.assessment, score: 40, dataConfidence: 80, canAutomateAlerts: true },
      })),
    };
    const current: DashboardSnapshot = {
      ...snapshot,
      groups: snapshot.groups.map((group) => ({
        ...group,
        assessment: { ...group.assessment, score: 55, dataConfidence: 80, canAutomateAlerts: true },
        officialMatch: { incident: { id: "incident-1", name: "Official incident", percentContained: 20, updatedAt: "2026-08-03T11:00:00.000Z" }, method: "proximity", distanceKm: 4 },
      })),
    };

    const alerts = deriveConsoleAlerts(previous, current);

    expect(alerts.map((alert) => alert.type)).toEqual(["new-satellite", "activity-resumed", "score-increase", "official-incident"]);
    expect(new Set(alerts.map((alert) => alert.dedupeKey)).size).toBe(alerts.length);
    expect(alerts.every((alert) => alert.acquiredAt && alert.source && alert.reason && alert.confidence && Number.isFinite(alert.distanceKm))).toBe(true);
  });

  it("does not alert for a bbox-corner group outside the selected asset radius", () => {
    const outsideRadius: DashboardSnapshot = {
      ...snapshot,
      groups: snapshot.groups.map((group) => ({
        ...group,
        cluster: { ...group.cluster, centroid: { lat: 42, lon: -116.54 } },
        assessment: { ...group.assessment, dataConfidence: 90, canAutomateAlerts: true },
      })),
    };

    expect(deriveConsoleAlerts(undefined, outsideRadius)).toEqual([]);
  });

  it("creates unique prompt and trace relationships for multiple agent panels", () => {
    render(<><AgentPanel snapshot={snapshot} /><AgentPanel snapshot={snapshot} /></>);
    const inputs = screen.getAllByLabelText("Ask Gemma about this asset");
    expect(inputs[0]?.id).not.toBe(inputs[1]?.id);
    const traceButtons = screen.getAllByRole("button", { name: /visible tool trace/i });
    expect(traceButtons[0]?.getAttribute("aria-controls")).not.toBe(traceButtons[1]?.getAttribute("aria-controls"));
  });

  it("aborts and ignores an in-flight agent response when the selected asset changes", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AgentPanel snapshot={snapshot} selectedAssetId="demo-antelope-ranch" />);

    fireEvent.click(screen.getByRole("button", { name: /when would smoke reach here/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    const nextSnapshot = {
      ...snapshot,
      asset: { ...snapshot.asset, id: "field-2", name: "Sierra Field" },
    };
    rerender(<AgentPanel snapshot={nextSnapshot} selectedAssetId="field-2" />);
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      resolveResponse?.(new Response(JSON.stringify({ status: "ok", answer: "Stale ranch answer", trace: [] }), { status: 200 }));
    });
    expect(screen.queryByText("Stale ranch answer")).toBeNull();
  });

  it("aborts and ignores an in-flight agent response when the same snapshot refreshes", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      void input;
      firstSignal = init?.signal ?? undefined;
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AgentPanel snapshot={snapshot} selectedAssetId="demo-antelope-ranch" />);

    fireEvent.click(screen.getByRole("button", { name: /when would smoke reach here/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<AgentPanel snapshot={{ ...snapshot, generatedAt: "2026-08-03T12:05:00.000Z" }} selectedAssetId="demo-antelope-ranch" />);
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      resolveResponse?.(new Response(JSON.stringify({ status: "ok", answer: "Stale pre-refresh answer", trace: [] }), { status: 200 }));
    });
    expect(screen.queryByText("Stale pre-refresh answer")).toBeNull();
  });

  it("treats a successful agent response with null JSON as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 200 })));
    render(<AgentPanel snapshot={snapshot} selectedAssetId="demo-antelope-ranch" />);

    fireEvent.click(screen.getByRole("button", { name: /when would smoke reach here/i }));

    expect(await screen.findByText(/returned an invalid response/i)).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  it("rejects setup radii outside the shared 1 to 100 km contract before saving", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupPanel onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "North Field" } });
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "41" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-116" } });
    fireEvent.change(screen.getByLabelText("Radius kilometers"), { target: { value: "100.01" } });
    fireEvent.submit(screen.getByRole("dialog"));

    expect(screen.getByRole("alert").textContent).toMatch(/between 1 and 100 kilometers/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves the exact 1 km and 100 km radius boundaries without conversion drift", async () => {
    const submittedRadii: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { radiusKm: number };
      submittedRadii.push(body.radiusKm);
      return new Response(JSON.stringify({ asset: { id: `asset-${body.radiusKm}`, name: "North Field", category: "field", location: { lat: 41, lon: -116 }, radiusKm: body.radiusKm } }), { status: 201 });
    }));
    render(<SetupPanel onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "North Field" } });
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "41" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-116" } });

    fireEvent.change(screen.getByLabelText("Radius kilometers"), { target: { value: "1" } });
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(submittedRadii).toEqual([1]));
    fireEvent.change(screen.getByLabelText("Radius kilometers"), { target: { value: "100" } });
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(submittedRadii).toEqual([1, 100]));
  });
});
