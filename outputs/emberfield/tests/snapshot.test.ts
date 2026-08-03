import { describe, expect, it, vi } from "vitest";

const workerEnvironment = vi.hoisted(() => ({ DB: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({ env: workerEnvironment }));

import { POST as postSnapshot } from "../app/api/snapshot/route";
import { DEMO_ASSET, DEMO_BBOX } from "../lib/fixtures/demo";
import {
  CACHE_TTLS,
  MemoryTtlCache,
} from "../lib/server/cache";
import { buildSnapshot } from "../lib/server/snapshot";

const now = new Date("2026-08-03T06:00:00.000Z");

const firmsPayload = {
  mode: "live" as const,
  status: "ok" as const,
  source: "NASA FIRMS" as const,
  fetchedAt: now.toISOString(),
  observedAt: "2026-08-03T05:00:00.000Z",
  detections: [
    {
      id: "first",
      fingerprint: "first",
      source: "VIIRS_NOAA20_NRT" as const,
      lat: 41.05,
      lon: -116.54,
      acquiredAt: "2026-08-03T04:00:00.000Z",
      satellite: "NOAA-20",
      confidence: "nominal" as const,
      frp: 12,
      frpMw: 12,
      brightnessTi4: 340,
      brightnessTi5: 300,
      dayNight: "D",
    },
    {
      id: "second",
      fingerprint: "second",
      source: "VIIRS_NOAA21_NRT" as const,
      lat: 41.051,
      lon: -116.541,
      acquiredAt: "2026-08-03T05:00:00.000Z",
      satellite: "NOAA-21",
      confidence: "high" as const,
      frp: 28,
      frpMw: 28,
      brightnessTi4: 350,
      brightnessTi5: 305,
      dayNight: "D",
    },
  ],
};

const weatherPayload = {
  mode: "live" as const,
  status: "ok" as const,
  source: "NWS" as const,
  sourceUrl: "https://api.weather.gov/gridpoints/LKN/1,2",
  fetchedAt: now.toISOString(),
  observedAt: "2026-08-03T05:00:00.000Z",
  weather: {
    windSpeedMps: 6,
    windFromDeg: 245,
    humidityPercent: 18,
    relativeHumidityPct: 18,
    quality: "direct-fresh" as const,
    observedAt: "2026-08-03T05:00:00.000Z",
    selectedValidTimes: {
      windSpeed: "2026-08-03T05:00:00+00:00/PT1H",
      windDirection: "2026-08-03T05:00:00+00:00/PT1H",
      relativeHumidity: "2026-08-03T05:00:00+00:00/PT1H",
    },
  },
};

const wfigsPayload = {
  mode: "live" as const,
  status: "ok" as const,
  source: "WFIGS" as const,
  fetchedAt: now.toISOString(),
  observedAt: "2026-08-03T05:00:00.000Z",
  incidents: [
    {
      id: "incident-1",
      irwinId: "irwin-1",
      name: "Antelope Creek",
      type: "WF",
      location: { lat: 41.049, lon: -116.544 },
      acres: 2500,
      percentContained: 35,
      discoveredAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-03T05:00:00.000Z",
    },
  ],
  perimeters: [
    {
      id: "perimeter-1",
      sourceGlobalId: "incident-1",
      irwinId: "irwin-1",
      name: "Antelope Creek",
      type: "WF",
      acres: 2500,
      percentContained: 35,
      currentAt: "2026-08-03T05:00:00.000Z",
      polygonAt: "2026-08-03T05:00:00.000Z",
      updatedAt: "2026-08-03T05:00:00.000Z",
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [-116.56, 41.04],
            [-116.52, 41.04],
            [-116.52, 41.07],
            [-116.56, 41.07],
            [-116.56, 41.04],
          ],
        ],
      },
    },
  ],
};

describe("source-aware cache", () => {
  it("deduplicates work until the requested source TTL expires", async () => {
    let clock = 1_000;
    const cache = new MemoryTtlCache(() => clock);
    const loader = vi.fn(async () => ({ value: "fresh" }));

    const first = await cache.getOrLoad("firms:demo", CACHE_TTLS.firms, loader);
    clock += CACHE_TTLS.firms - 1;
    const second = await cache.getOrLoad("firms:demo", CACHE_TTLS.firms, loader);
    clock += 2;
    const third = await cache.getOrLoad("firms:demo", CACHE_TTLS.firms, loader);

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(third.cache).toBe("miss");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed upstream work", async () => {
    const cache = new MemoryTtlCache(() => 1_000);
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("recovered");

    await expect(cache.getOrLoad("nws:grid", CACHE_TTLS.nwsObservations, loader))
      .rejects.toThrow("offline");
    await expect(cache.getOrLoad("nws:grid", CACHE_TTLS.nwsObservations, loader))
      .resolves.toMatchObject({ value: "recovered", cache: "miss" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("bypasses a valid entry for an explicit refresh and replaces it", async () => {
    const cache = new MemoryTtlCache(() => 1_000);
    const loader = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("cached")
      .mockResolvedValueOnce("refreshed");

    await cache.getOrLoad("firms:refresh", CACHE_TTLS.firms, loader);
    const refreshed = await cache.getOrLoad(
      "firms:refresh",
      CACHE_TTLS.firms,
      loader,
      { refresh: true },
    );
    const afterRefresh = await cache.getOrLoad(
      "firms:refresh",
      CACHE_TTLS.firms,
      loader,
    );

    expect(refreshed).toMatchObject({ value: "refreshed", cache: "miss" });
    expect(afterRefresh).toMatchObject({ value: "refreshed", cache: "hit" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not let older in-flight work overwrite a completed refresh", async () => {
    const cache = new MemoryTtlCache(() => 1_000);
    let resolveOlder!: (value: string) => void;
    const older = cache.getOrLoad(
      "wfigs:refresh-race",
      CACHE_TTLS.wfigs,
      () =>
        new Promise<string>((resolve) => {
          resolveOlder = resolve;
        }),
    );
    await Promise.resolve();

    const refreshed = await cache.getOrLoad(
      "wfigs:refresh-race",
      CACHE_TTLS.wfigs,
      async () => "refreshed",
      { refresh: true },
    );
    resolveOlder("older");
    await older;
    const cached = await cache.getOrLoad(
      "wfigs:refresh-race",
      CACHE_TTLS.wfigs,
      async () => "unexpected",
    );

    expect(refreshed.value).toBe("refreshed");
    expect(cached).toMatchObject({ value: "refreshed", cache: "hit" });
  });

  it("does not populate the cache after its caller aborts", async () => {
    vi.useFakeTimers();
    const cache = new MemoryTtlCache(() => 1_000);
    const controller = new AbortController();
    const loader = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("too-late"), 50_000);
        }),
    );

    const pending = cache.getOrLoad("airnow:abort", CACHE_TTLS.airnow, loader, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(50_000);

    await cache.getOrLoad("airnow:abort", CACHE_TTLS.airnow, async () => "fresh");
    expect(loader).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("snapshot composition", () => {
  it("counts repeated observation times from the same satellite as distinct passes", async () => {
    const repeatedPass = {
      ...firmsPayload.detections[0],
      id: "repeat-pass",
      fingerprint: "repeat-pass",
      acquiredAt: "2026-08-03T05:30:00.000Z",
    };
    const samePassPixel = {
      ...repeatedPass,
      id: "same-pass-pixel",
      fingerprint: "same-pass-pixel",
      lat: repeatedPass.lat + 0.001,
    };
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => ({
          ...firmsPayload,
          detections: [
            ...firmsPayload.detections,
            repeatedPass,
            samePassPixel,
          ],
        }),
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => ({
          ...wfigsPayload,
          incidents: [],
          perimeters: [],
        }),
      },
    );
    const passContribution = snapshot.groups[0].assessment.contributions.find(
      ({ code }) => code === "distinct-passes",
    );

    expect(snapshot.groups[0].cluster.satellites).toEqual(["NOAA-20", "NOAA-21"]);
    expect(snapshot.groups[0].cluster.detectionCount).toBe(4);
    expect(passContribution?.normalizedValue).toBe(0.6);
  });

  it("enforces the exact asset radius before clustering", async () => {
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => ({
          ...firmsPayload,
          detections: [
            firmsPayload.detections[0],
            {
              ...firmsPayload.detections[1],
              id: "outside-circle",
              fingerprint: "outside-circle",
              lat: DEMO_ASSET.location.lat + 1,
              lon: DEMO_ASSET.location.lon,
            },
          ],
        }),
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => ({ ...wfigsPayload, incidents: [], perimeters: [] }),
      },
    );

    expect(snapshot.detections.map(({ id }) => id)).toEqual(["first"]);
    expect(snapshot.groups).toHaveLength(1);
  });

  it("excludes official perimeters whose geometry does not intersect the asset radius", async () => {
    const outsidePerimeter = {
      ...wfigsPayload.perimeters[0],
      id: "outside-radius",
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [-116.56, 41.48],
          [-116.52, 41.48],
          [-116.52, 41.49],
          [-116.56, 41.49],
          [-116.56, 41.48],
        ]],
      },
    };
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => ({ ...firmsPayload, detections: [] }),
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => ({
          ...wfigsPayload,
          perimeters: [...wfigsPayload.perimeters, outsidePerimeter],
        }),
      },
    );

    expect(snapshot.perimeters.map(({ id }) => id)).toEqual(["perimeter-1"]);
    expect(snapshot.limits?.exactRadiusApplied).toBe(true);
  });

  it("bounds NWS work to four concurrent cluster lookups", async () => {
    let active = 0;
    let maximumActive = 0;
    const detections = Array.from({ length: 8 }, (_, index) => ({
      ...firmsPayload.detections[0],
      id: `weather-${index}`,
      fingerprint: `weather-${index}`,
      lat: DEMO_ASSET.location.lat + index * 0.025,
      lon: DEMO_ASSET.location.lon,
    }));

    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => ({ ...firmsPayload, detections }),
        fetchWeather: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return weatherPayload;
        },
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => ({ ...wfigsPayload, incidents: [], perimeters: [] }),
      },
    );

    expect(snapshot.groups).toHaveLength(8);
    expect(maximumActive).toBeLessThanOrEqual(4);
  });

  it("caps oversized source results and makes the truncation explicit", async () => {
    const detections = Array.from({ length: 1_501 }, (_, index) => ({
      ...firmsPayload.detections[0],
      id: `detection-${index}`,
      fingerprint: `detection-${index}`,
      lat: DEMO_ASSET.location.lat,
      lon: DEMO_ASSET.location.lon,
    }));
    const incidents = Array.from({ length: 251 }, (_, index) => ({
      ...wfigsPayload.incidents[0],
      id: `incident-${index}`,
      irwinId: `irwin-${index}`,
    }));
    const perimeters = Array.from({ length: 101 }, (_, index) => ({
      ...wfigsPayload.perimeters[0],
      id: `perimeter-${index}`,
      irwinId: `irwin-${index}`,
    }));

    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => ({ ...firmsPayload, detections }),
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => ({ ...wfigsPayload, incidents, perimeters }),
      },
    );

    expect(snapshot.detections).toHaveLength(1_500);
    expect(snapshot.incidents).toHaveLength(250);
    expect(snapshot.perimeters).toHaveLength(100);
    expect(snapshot.limits).toMatchObject({
      truncated: expect.arrayContaining(["detections", "incidents", "perimeters"]),
      alertsAutomated: false,
    });
    expect(snapshot.sources.firms.status).toBe("partial");
    expect(snapshot.sources.wfigs.status).toBe("partial");
    expect(snapshot.groups.every(({ assessment }) => !assessment.canAutomateAlerts))
      .toBe(true);
  });

  it("disables automated alerts when an upstream WFIGS page is partial", async () => {
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => firmsPayload,
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => ({ ...wfigsPayload, status: "partial" }),
      },
    );

    expect(snapshot.sources.wfigs.status).toBe("partial");
    expect(snapshot.limits?.alertsAutomated).toBe(false);
    expect(snapshot.groups.every(({ assessment }) => !assessment.canAutomateAlerts))
      .toBe(true);
  });

  it("propagates refresh and cancellation options to every source adapter", async () => {
    const controller = new AbortController();
    const seen: Array<{ refresh?: boolean; signal?: AbortSignal }> = [];
    const record = (dependencies: { refresh?: boolean; signal?: AbortSignal }) => {
      seen.push(dependencies);
    };

    await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        refresh: true,
        signal: controller.signal,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "configured" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async (_input, dependencies) => {
          record(dependencies ?? {});
          return firmsPayload;
        },
        fetchWeather: async (_input, dependencies) => {
          record(dependencies ?? {});
          return weatherPayload;
        },
        fetchAir: async (_input, dependencies) => {
          record(dependencies ?? {});
          return {
            mode: "live",
            status: "ok",
            source: "AirNow",
            fetchedAt: now.toISOString(),
            observedAt: null,
            observations: [],
            air: null,
          };
        },
        fetchWfigs: async (_input, dependencies) => {
          record(dependencies ?? {});
          return wfigsPayload;
        },
      },
    );

    expect(seen).toHaveLength(4);
    expect(seen.every(({ refresh, signal }) => refresh && signal === controller.signal))
      .toBe(true);
  });

  it("preserves partial success, assesses clusters, and associates containing perimeters", async () => {
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "configured" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => firmsPayload,
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => {
          throw new Error("AirNow offline");
        },
        fetchWfigs: async () => wfigsPayload,
      },
    );

    expect(snapshot).toMatchObject({
      mode: "live",
      generatedAt: "2026-08-03T06:00:00.000Z",
      sources: {
        firms: {
          status: "ok",
          mode: "live",
          source: "NASA FIRMS",
          sourceUrl: null,
        },
        nws: {
          status: "ok",
          mode: "live",
          source: "NWS",
          sourceUrl: "https://api.weather.gov/gridpoints/LKN/1,2",
          sourceUrls: ["https://api.weather.gov/gridpoints/LKN/1,2"],
          coverage: { succeeded: 1, failed: 0, total: 1 },
        },
        airnow: {
          status: "error",
          mode: "live",
          source: "AirNow",
          sourceUrl: null,
        },
        wfigs: {
          status: "ok",
          mode: "live",
          source: "WFIGS",
          sourceUrl: null,
        },
      },
    });
    expect(snapshot.detections).toHaveLength(2);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].assessment.score).not.toBeNull();
    expect(snapshot.groups[0].officialMatch).toMatchObject({
      incident: { id: "incident-1" },
      method: "perimeter",
    });
  });

  it("never substitutes fixture records when live FIRMS fails", async () => {
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => {
          throw new Error("FIRMS offline");
        },
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => wfigsPayload,
      },
    );

    expect(snapshot.mode).toBe("live");
    expect(snapshot.detections).toEqual([]);
    expect(snapshot.sources.firms.status).toBe("error");
    expect(JSON.stringify(snapshot.sources)).not.toContain("configured");
  });

  it("never propagates FIRMS or AirNow credential-bearing source URLs", async () => {
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "firms-secret" },
          airnow: { apiKey: "airnow-secret" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => ({
          ...firmsPayload,
          sourceUrl:
            "https://firms.modaps.eosdis.nasa.gov/api/area/csv/firms-secret/feed/bbox/1",
        }),
        fetchWeather: async () => weatherPayload,
        fetchAir: async () => ({
          mode: "live",
          status: "ok",
          source: "AirNow",
          sourceUrl:
            "https://www.airnowapi.org/aq/observation/latLong/current/?API_KEY=airnow-secret",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => wfigsPayload,
      },
    );

    expect(snapshot.sources.firms.sourceUrl).toBeNull();
    expect(snapshot.sources.airnow.sourceUrl).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("firms-secret");
    expect(JSON.stringify(snapshot)).not.toContain("airnow-secret");
  });

  it("reports explicit partial NWS coverage when one cluster lookup fails", async () => {
    const splitFirmsPayload = {
      ...firmsPayload,
      detections: [
        ...firmsPayload.detections,
        {
          ...firmsPayload.detections[0],
          id: "distant",
          fingerprint: "distant",
          lat: 41.15,
          lon: -116.65,
          acquiredAt: "2026-08-03T05:30:00.000Z",
        },
      ],
    };
    const fetchWeather = vi
      .fn()
      .mockResolvedValueOnce(weatherPayload)
      .mockRejectedValueOnce(new Error("one NWS grid unavailable"));

    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
      {
        now: () => now,
        config: {
          firms: { mapKey: "configured" },
          airnow: { apiKey: "" },
          ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b" },
        },
        fetchFirms: async () => splitFirmsPayload,
        fetchWeather,
        fetchAir: async () => ({
          mode: "live",
          status: "missing-key",
          source: "AirNow",
          fetchedAt: now.toISOString(),
          observedAt: null,
          observations: [],
          air: null,
        }),
        fetchWfigs: async () => wfigsPayload,
      },
    );

    expect(snapshot.groups).toHaveLength(2);
    expect(snapshot.groups.filter(({ weather }) => weather !== null)).toHaveLength(1);
    expect(snapshot.sources.nws).toMatchObject({
      status: "partial",
      source: "NWS",
      coverage: { succeeded: 1, failed: 1, total: 2 },
    });
  });

  it("uses only shifted, explicitly labeled data in fixture mode", async () => {
    const liveCall = vi.fn(async () => {
      throw new Error("fixture mode called a live adapter");
    });
    const snapshot = await buildSnapshot(
      { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "fixture" },
      {
        now: () => now,
        fetchFirms: liveCall,
        fetchWeather: liveCall,
        fetchAir: liveCall,
        fetchWfigs: liveCall,
      },
    );

    expect(snapshot.mode).toBe("fixture");
    expect(Object.values(snapshot.sources).every(({ mode }) => mode === "fixture"))
      .toBe(true);
    expect(snapshot.detections.length).toBeGreaterThan(0);
    expect(
      snapshot.detections.every(({ acquiredAt }) => {
        const age = now.getTime() - Date.parse(acquiredAt);
        return age >= 0 && age <= 24 * 60 * 60 * 1_000;
      }),
    ).toBe(true);
    expect(liveCall).not.toHaveBeenCalled();
  });
});

describe("snapshot POST contract", () => {
  it("serves the explicit virtual demo identity from a bounded JSON request", async () => {
    const response = await postSnapshot(
      new Request("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: DEMO_ASSET.id, mode: "fixture" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("fixture");
    expect(payload.asset.id).toBe(DEMO_ASSET.id);
    expect(payload.persisted).toBe(false);
    expect(payload.history24h).toMatchObject({ runs: [], alerts: expect.any(Array) });
  });

  it("rejects unsupported modes", async () => {
    const response = await postSnapshot(
      new Request("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: DEMO_ASSET.id, mode: "demo" }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects cross-site browser requests before doing snapshot work", async () => {
    const response = await postSnapshot(
      new Request("http://localhost/api/snapshot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ assetId: DEMO_ASSET.id, mode: "fixture" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("rejects snapshot bodies larger than one kilobyte", async () => {
    const response = await postSnapshot(
      new Request("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: DEMO_ASSET.id,
          mode: "fixture",
          padding: "x".repeat(1_024),
        }),
      }),
    );

    expect(response.status).toBe(413);
  });
});
