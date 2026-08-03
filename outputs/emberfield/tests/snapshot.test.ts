import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { GET as getSnapshot } from "../app/api/snapshot/route";
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
});

describe("snapshot composition", () => {
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
        firms: { status: "ok", mode: "live" },
        nws: { status: "ok", mode: "live" },
        airnow: { status: "error", mode: "live" },
        wfigs: { status: "ok", mode: "live" },
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

describe("snapshot route fixture gate", () => {
  it("serves fixture data only for the explicit fixture query", async () => {
    const response = await getSnapshot(
      new Request("http://localhost/api/snapshot?mode=fixture"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("fixture");
  });

  it("rejects unsupported modes", async () => {
    const response = await getSnapshot(
      new Request("http://localhost/api/snapshot?mode=demo"),
    );

    expect(response.status).toBe(400);
  });
});
