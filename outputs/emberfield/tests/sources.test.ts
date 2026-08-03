import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHealth, getRuntimeConfig } from "../lib/server/config";
import { CACHE_TTLS, MemoryTtlCache } from "../lib/server/cache";
import {
  fetchAirQuality,
  parseAirNow,
} from "../lib/sources/airnow";
import {
  geocodeAddress,
  parseCensusResponse,
} from "../lib/sources/census";
import {
  FIRMS_SOURCES,
  fetchFirmsDetections,
  parseFirmsCsv,
} from "../lib/sources/firms";
import { fetchWeatherContext, parseNwsGrid } from "../lib/sources/nws";
import {
  boundedText,
  fetchWithTimeout,
} from "../lib/sources/shared";
import { fetchWfigs, parseWfigsGeoJson } from "../lib/sources/wfigs";

const okFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({ models: [{ name: "gemma4:12b" }] }),
    { status: 200 },
  );

describe("runtime configuration and source health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports required and optional integrations without exposing secrets", async () => {
    const health = await buildHealth(
      { FIRMS_MAP_KEY: "secret", AIRNOW_API_KEY: "" },
      okFetch,
    );

    expect(health.integrations.firms).toMatchObject({ configured: true });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("uses defaults and prefers worker bindings over process environment", () => {
    const previousUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "http://process.example";

    try {
      expect(
        getRuntimeConfig({ OLLAMA_BASE_URL: "http://worker.example" })
          .ollama.baseUrl,
      ).toBe("http://worker.example");
      expect(getRuntimeConfig({}).ollama.model).toBe("gemma4:12b");
      expect(getRuntimeConfig({ OLLAMA_MODEL: "another-model" }).ollama.model)
        .toBe("gemma4:12b");
    } finally {
      if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = previousUrl;
    }
  });

  it("labels a missing firms key without probing the unavailable source", async () => {
    const health = await buildHealth({ FIRMS_MAP_KEY: "" }, okFetch);

    expect(health.integrations.firms).toMatchObject({
      configured: false,
      status: "missing-key",
    });
  });

  it("labels an unavailable Ollama source as offline", async () => {
    const offlineFetch: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const health = await buildHealth({}, offlineFetch);

    expect(health.integrations.ollama).toMatchObject({ status: "offline" });
  });

  it("labels a rejected Ollama probe as an error", async () => {
    const rejectedFetch: typeof fetch = async () => new Response(null, { status: 503 });

    const health = await buildHealth({}, rejectedFetch);

    expect(health.integrations.ollama).toMatchObject({ status: "error" });
  });

  it("does not report Ollama ready when the required Gemma model is absent", async () => {
    const noGemmaFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ models: [{ name: "another-model:latest" }] }), {
        status: 200,
      });

    const health = await buildHealth({}, noGemmaFetch);

    expect(health.integrations.ollama).toMatchObject({
      configured: false,
      status: "error",
    });
  });

  it("bounds the Ollama probe to two seconds", async () => {
    vi.useFakeTimers();
    const timeoutFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "AbortError")),
        );
      });

    const pendingHealth = buildHealth({}, timeoutFetch);
    await vi.advanceTimersByTimeAsync(2_000);
    const health = await pendingHealth;

    expect(health.integrations.ollama).toMatchObject({ status: "offline" });
  });

  it("propagates an external abort through the source fetch lifecycle", async () => {
    const controller = new AbortController();
    const observedAbort = vi.fn();
    const pendingFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            observedAbort();
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });

    const pending = fetchWithTimeout(
      "FIRMS",
      "https://example.test/source",
      {},
      pendingFetch,
      12_000,
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(observedAbort).toHaveBeenCalledOnce();
  });
});

const firmsCsv = `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
41.0521,-116.5482,342.8,0.4,0.4,2026-08-03,427,N20,VIIRS,n,2.0NRT,301.2,14.32,D`;

const nwsGrid = {
  properties: {
    windSpeed: {
      uom: "wmoUnit:km_h-1",
      values: [
        { validTime: "2026-08-03T04:00:00+00:00/PT1H", value: 18 },
      ],
    },
    windDirection: {
      uom: "wmoUnit:degree_(angle)",
      values: [
        { validTime: "2026-08-03T04:00:00+00:00/PT1H", value: 245 },
      ],
    },
    relativeHumidity: {
      uom: "wmoUnit:percent",
      values: [
        { validTime: "2026-08-03T03:00:00+00:00/PT1H", value: null },
        { validTime: "2026-08-03T05:00:00+00:00/PT1H", value: 18 },
      ],
    },
  },
};

const airNowJson = [
  {
    DateObserved: "2026-08-03",
    HourObserved: 4,
    LocalTimeZone: "PDT",
    ReportingArea: "Winnemucca",
    StateCode: "NV",
    Latitude: 40.97,
    Longitude: -117.73,
    ParameterName: "O3",
    AQI: 40,
    Category: { Number: 1, Name: "Good" },
  },
  {
    DateObserved: "2026-08-03",
    HourObserved: 4,
    LocalTimeZone: "PDT",
    ReportingArea: "Winnemucca",
    StateCode: "NV",
    Latitude: 40.97,
    Longitude: -117.73,
    ParameterName: "PM2.5",
    AQI: 71,
    Category: { Number: 2, Name: "Moderate" },
  },
];

const censusJson = {
  result: {
    input: {
      benchmark: {
        id: "4",
        benchmarkName: "Public_AR_Current",
      },
    },
    addressMatches: [
      {
        matchedAddress: "123 RANCH RD, WINNEMUCCA, NV, 89445",
        coordinates: { x: -117.7357, y: 40.9729 },
        tigerLine: { tigerLineId: "123", side: "L" },
        addressComponents: {
          fromAddress: "123",
          streetName: "RANCH",
          suffixType: "RD",
          city: "WINNEMUCCA",
          state: "NV",
          zip: "89445",
        },
      },
    ],
  },
};

const wfigsPoints = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 15,
      geometry: { type: "Point", coordinates: [-116.543867, 41.049033] },
      properties: {
        OBJECTID: 15,
        GlobalID: "{point-global-id}",
        IrwinID: "{irwin-id}",
        IncidentName: "Antelope Creek",
        IncidentTypeCategory: "WF",
        IncidentSize: 2540,
        PercentContained: 35,
        FireDiscoveryDateTime: 1785729600000,
        ModifiedOnDateTime_dt: 1785733200000,
      },
    },
  ],
};

const wfigsPerimeters = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 16,
      geometry: {
        type: "Polygon",
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
      properties: {
        OBJECTID: 16,
        GlobalID: "{perimeter-global-id}",
        poly_SourceGlobalID: "{point-global-id}",
        poly_IRWINID: "{irwin-id}",
        poly_IncidentName: "Antelope Creek",
        poly_GISAcres: 2512,
        poly_DateCurrent: 1785733200000,
        poly_PolygonDateTime: 1785731400000,
        attr_PercentContained: 35,
        attr_IncidentTypeCategory: "WF",
        attr_ModifiedOnDateTime_dt: 1785733200000,
      },
    },
  ],
};

describe("source payload parsers", () => {
  it("normalizes a FIRMS row using UTC time and an immutable fingerprint", () => {
    const detection = parseFirmsCsv(firmsCsv, "VIIRS_NOAA20_NRT")[0];

    expect(detection).toMatchObject({
      satellite: "NOAA-20",
      acquiredAt: "2026-08-03T04:27:00.000Z",
      confidence: "nominal",
      frp: 14.32,
      frpMw: 14.32,
      fingerprint:
        "VIIRS_NOAA20_NRT|NOAA-20|2026-08-03|0427|41.0521|-116.5482",
    });
  });

  it("selects each NWS series independently and converts wind speed", () => {
    expect(
      parseNwsGrid(nwsGrid, new Date("2026-08-03T04:30:00.000Z")),
    ).toMatchObject({
      windSpeedMps: 5,
      windFromDeg: 245,
      humidityPercent: 18,
      relativeHumidityPct: 18,
      observedAt: "2026-08-03T05:00:00.000Z",
      selectedValidTimes: {
        windSpeed: "2026-08-03T04:00:00+00:00/PT1H",
        windDirection: "2026-08-03T04:00:00+00:00/PT1H",
        relativeHumidity: "2026-08-03T05:00:00+00:00/PT1H",
      },
    });
  });

  it("preserves AirNow observation evidence and selects exact PM2.5", () => {
    const observations = parseAirNow(airNowJson);

    expect(observations[1]).toMatchObject({
      parameter: "PM2.5",
      aqi: 71,
      localTimeZone: "PDT",
      reportingArea: "Winnemucca",
      category: { number: 2, name: "Moderate" },
    });
  });

  it("normalizes Census coordinates and benchmark provenance", () => {
    expect(parseCensusResponse(censusJson)).toMatchObject({
      status: "ok",
      match: {
        matchedAddress: "123 RANCH RD, WINNEMUCCA, NV, 89445",
        location: { lat: 40.9729, lon: -117.7357 },
      },
      benchmark: { id: "4", name: "Public_AR_Current" },
    });
  });

  it("normalizes WFIGS point and perimeter identity and UTC dates", () => {
    expect(parseWfigsGeoJson(wfigsPoints, "points").incidents[0]).toMatchObject({
      id: "{point-global-id}",
      irwinId: "{irwin-id}",
      name: "Antelope Creek",
      location: { lat: 41.049033, lon: -116.543867 },
      updatedAt: "2026-08-03T05:00:00.000Z",
    });
    expect(
      parseWfigsGeoJson(wfigsPerimeters, "perimeters").perimeters[0],
    ).toMatchObject({
      id: "{perimeter-global-id}",
      irwinId: "{irwin-id}",
      name: "Antelope Creek",
      acres: 2512,
    });
  });

  it("preserves nullable WFIGS dates without inventing an epoch timestamp", () => {
    const payload = structuredClone(wfigsPoints) as unknown as {
      features: Array<{ properties: Record<string, unknown> }>;
    };
    payload.features[0].properties.ModifiedOnDateTime_dt = null;

    expect(parseWfigsGeoJson(payload, "points").incidents[0].updatedAt).toBeNull();
  });
});

describe("bounded source response handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the request timeout active while a streamed body is consumed", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      let bodyTimer: ReturnType<typeof setTimeout> | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              if (bodyTimer) clearTimeout(bodyTimer);
              controller.error(new DOMException("Timed out", "AbortError"));
            });
          },
          pull(controller) {
            return new Promise<void>((resolve) => {
              bodyTimer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("eventually"));
                controller.close();
                resolve();
              }, 200);
            });
          },
        }),
      );
    };

    const response = await fetchWithTimeout(
      "Test source",
      "https://example.test/slow",
      {},
      fetchImplementation,
      100,
    );
    const pendingBody = boundedText("Test source", response, 100);
    const rejection = expect(pendingBody).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(aborted).toBe(true);
  });

  it("cancels a chunked response as soon as its byte limit is exceeded", async () => {
    let cancelled = false;
    let pulls = 0;
    const fetchImplementation: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(8));
            if (pulls === 10) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );

    const response = await fetchWithTimeout(
      "Test source",
      "https://example.test/chunked",
      {},
      fetchImplementation,
      1_000,
    );

    await expect(boundedText("Test source", response, 10)).rejects.toMatchObject({
      code: "response-too-large",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });
});

describe("live source adapters", () => {
  it("calls all configured FIRMS feeds without exposing the key in errors", async () => {
    const requested: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      requested.push(String(input));
      return new Response(firmsCsv, { status: 200 });
    };

    const result = await fetchFirmsDetections(
      {
        mapKey: "top-secret-key",
        bbox: {
          west: -117.19,
          south: 40.6,
          east: -115.89,
          north: 41.5,
          crossesAntimeridian: false,
        },
      },
      { fetchImplementation, now: () => new Date("2026-08-03T05:00:00Z") },
    );

    expect(result.status).toBe("ok");
    expect(result.detections).toHaveLength(FIRMS_SOURCES.length);
    expect(requested).toHaveLength(FIRMS_SOURCES.length);
    expect(requested.every((url) => url.endsWith("/1"))).toBe(true);

    const rejectedFetch: typeof fetch = async () => {
      throw new TypeError("request failed for a credential-bearing URL");
    };
    await expect(
      fetchFirmsDetections(
        {
          mapKey: "top-secret-key",
          bbox: {
            west: -117.19,
            south: 40.6,
            east: -115.89,
            north: 41.5,
            crossesAntimeridian: false,
          },
        },
        { fetchImplementation: rejectedFetch },
      ),
    ).rejects.not.toThrow("top-secret-key");
  });

  it("returns typed Census no-match and validates address length before fetch", async () => {
    const emptyFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          result: {
            input: { benchmark: { id: "4", benchmarkName: "Public_AR_Current" } },
            addressMatches: [],
          },
        }),
      );

    await expect(geocodeAddress("Unknown ranch", { fetchImplementation: emptyFetch }))
      .resolves.toMatchObject({ status: "no-match" });

    const neverFetch = vi.fn<typeof fetch>();
    await expect(
      geocodeAddress("a".repeat(101), { fetchImplementation: neverFetch }),
    ).rejects.toMatchObject({ code: "invalid-address" });
    expect(neverFetch).not.toHaveBeenCalled();
  });

  it("follows the NWS grid URL with an identifying User-Agent", async () => {
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        userAgent: new Headers(init?.headers).get("User-Agent"),
      });
      if (requests.length === 1) {
        return Response.json({
          properties: { forecastGridData: "https://api.weather.gov/gridpoints/LKN/1,2" },
        });
      }
      return Response.json(nwsGrid);
    };

    const result = await fetchWeatherContext(
      {
        location: { lat: 41.049033, lon: -116.543867 },
        at: new Date("2026-08-03T04:30:00Z"),
      },
      { fetchImplementation, now: () => new Date("2026-08-03T05:00:00Z") },
    );

    expect(result).toMatchObject({
      observedAt: "2026-08-03T05:00:00.000Z",
      sourceUrl: "https://api.weather.gov/gridpoints/LKN/1,2",
      weather: {
        relativeHumidityPct: 18,
        observedAt: "2026-08-03T05:00:00.000Z",
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests.every(({ userAgent }) => userAgent?.includes("EmberField")))
      .toBe(true);
    expect(
      requests.every(({ userAgent }) =>
        userAgent?.includes("https://github.com/frenzy2004/FireWood"),
      ),
    ).toBe(true);
  });

  it("caches NWS point mapping longer than the grid observation", async () => {
    let clock = Date.parse("2026-08-03T05:00:00Z");
    const cache = new MemoryTtlCache(() => clock);
    const requests: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      return url.includes("/points/")
        ? Response.json({
            properties: {
              forecastGridData: "https://api.weather.gov/gridpoints/LKN/1,2",
            },
          })
        : Response.json(nwsGrid);
    };
    const input = {
      location: { lat: 41.049033, lon: -116.543867 },
      at: new Date("2026-08-03T04:30:00Z"),
    };

    await fetchWeatherContext(input, { fetchImplementation, cache });
    await fetchWeatherContext(input, { fetchImplementation, cache });
    clock += CACHE_TTLS.nwsObservations + 1;
    await fetchWeatherContext(input, { fetchImplementation, cache });

    expect(requests.filter((url) => url.includes("/points/"))).toHaveLength(1);
    expect(requests.filter((url) => url.includes("/gridpoints/"))).toHaveLength(2);
  });

  it("returns typed AirNow missing-key and rejects service error payloads", async () => {
    const neverFetch = vi.fn<typeof fetch>();
    await expect(
      fetchAirQuality(
        { apiKey: "", location: { lat: 41, lon: -116 } },
        { fetchImplementation: neverFetch },
      ),
    ).resolves.toMatchObject({ status: "missing-key", air: null });
    expect(neverFetch).not.toHaveBeenCalled();

    const serviceErrorFetch: typeof fetch = async () =>
      Response.json({ WebServiceError: [{ Message: "Invalid API key" }] });
    await expect(
      fetchAirQuality(
        { apiKey: "bad-key", location: { lat: 41, lon: -116 } },
        { fetchImplementation: serviceErrorFetch },
      ),
    ).rejects.toMatchObject({ code: "service-error" });
  });

  it("queries WFIGS points and perimeters with a bounded envelope", async () => {
    const requested: URL[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      return Response.json(
        url.pathname.includes("Incident_Locations") ? wfigsPoints : wfigsPerimeters,
      );
    };

    const result = await fetchWfigs(
      {
        bbox: {
          west: -117.19,
          south: 40.6,
          east: -115.89,
          north: 41.5,
          crossesAntimeridian: false,
        },
      },
      { fetchImplementation, now: () => new Date("2026-08-03T05:00:00Z") },
    );

    expect(result).toMatchObject({ status: "ok" });
    expect(result.incidents).toHaveLength(1);
    expect(result.perimeters).toHaveLength(1);
    expect(requested).toHaveLength(2);
    expect(requested.every((url) => url.searchParams.get("geometry") === "-117.19,40.6,-115.89,41.5"))
      .toBe(true);
    expect(requested.find((url) => url.pathname.includes("Incident_Locations"))
      ?.searchParams.get("resultRecordCount")).toBe("500");
    expect(requested.find((url) => url.pathname.includes("Perimeters"))
      ?.searchParams.get("resultRecordCount")).toBe("100");
  });

  it("stops WFIGS at one bounded page per layer and reports possible truncation", async () => {
    const requested: URL[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      const source = url.pathname.includes("Incident_Locations")
        ? wfigsPoints
        : wfigsPerimeters;
      const layerLimit = url.pathname.includes("Incident_Locations") ? 500 : 100;
      return Response.json({
        ...source,
        features: Array.from({ length: layerLimit }, (_, index) => ({
          ...source.features[0],
          id: index,
        })),
      });
    };

    const result = await fetchWfigs(
      {
        bbox: {
          west: -117.19,
          south: 40.6,
          east: -115.89,
          north: 41.5,
          crossesAntimeridian: false,
        },
      },
      { fetchImplementation },
    );

    expect(result.status).toBe("partial");
    expect(requested).toHaveLength(2);
  });

  it("rejects a WFIGS perimeter before normalizing more than ten thousand coordinates", () => {
    const oversized = structuredClone(wfigsPerimeters) as typeof wfigsPerimeters;
    oversized.features[0].geometry.coordinates = [[
      ...Array.from({ length: 10_001 }, (_, index) => [
        -116.56 + index * 0.000001,
        41.04,
      ]),
      [-116.56, 41.04],
    ]];

    expect(() => parseWfigsGeoJson(oversized, "perimeters")).toThrow(
      "WFIGS perimeter geometry exceeds the coordinate limit",
    );
  });
});
