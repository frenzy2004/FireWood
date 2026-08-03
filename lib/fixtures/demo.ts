import type { Asset, BoundingBox, Detection } from "../domain/types";
import type { WfigsGeometry } from "../sources/wfigs";

export const DEMO_ASSET: Asset = {
  id: "demo-antelope-ranch",
  name: "Antelope Creek Ranch",
  location: { lat: 41.049033, lon: -116.543867 },
  radiusKm: 45,
};

export const DEMO_BBOX: BoundingBox = {
  west: -117.19,
  south: 40.6,
  east: -115.89,
  north: 41.5,
  crossesAntimeridian: false,
};

const shifted = (now: Date, minutesAgo: number) =>
  new Date(now.getTime() - minutesAgo * 60_000).toISOString();

export interface FixtureSource<T> {
  mode: "fixture";
  status: "ok";
  source: string;
  fetchedAt: string;
  observedAt: string | null;
  data: T;
}

export interface DemoFixture {
  firms: FixtureSource<{ detections: Detection[] }>;
  nws: FixtureSource<{
    weather: {
      windSpeedMps: number;
      windFromDeg: number;
      relativeHumidityPct: number;
      humidityPercent: number;
      quality: "direct-fresh";
      observedAt: string;
    };
  }>;
  airnow: FixtureSource<{
    air: {
      pm25UgM3: null;
      aqi: number;
      quality: "direct-fresh";
      observedAt: string;
    };
  }>;
  wfigs: FixtureSource<{
    incidents: Array<{
      id: string;
      irwinId: string;
      name: string;
      type: string;
      location: { lat: number; lon: number };
      acres: number;
      percentContained: number;
      discoveredAt: string;
      updatedAt: string;
    }>;
    perimeters: Array<{
      id: string;
      sourceGlobalId: string;
      irwinId: string;
      name: string;
      type: string;
      acres: number;
      percentContained: number;
      currentAt: string;
      polygonAt: string;
      updatedAt: string;
      geometry: WfigsGeometry;
    }>;
  }>;
}

export function createDemoFixture(now: Date = new Date()): DemoFixture {
  const fetchedAt = now.toISOString();
  const latest = shifted(now, 35);
  const weatherObservedAt = shifted(now, 30);
  const officialUpdatedAt = shifted(now, 20);
  const detections: Detection[] = [
    {
      id: "fixture-noaa20-1",
      source: "fixture:VIIRS_NOAA20_NRT",
      lat: 41.053,
      lon: -116.547,
      acquiredAt: shifted(now, 210),
      satellite: "NOAA-20",
      confidence: "nominal",
      frpMw: 13.8,
    },
    {
      id: "fixture-snpp-1",
      source: "fixture:VIIRS_SNPP_NRT",
      lat: 41.051,
      lon: -116.545,
      acquiredAt: shifted(now, 95),
      satellite: "SNPP",
      confidence: "high",
      frpMw: 31.4,
    },
    {
      id: "fixture-noaa21-1",
      source: "fixture:VIIRS_NOAA21_NRT",
      lat: 41.0495,
      lon: -116.543,
      acquiredAt: latest,
      satellite: "NOAA-21",
      confidence: "nominal",
      frpMw: 22.1,
    },
  ];
  const geometry: WfigsGeometry = {
    type: "Polygon",
    coordinates: [
      [
        [-116.565, 41.038],
        [-116.522, 41.038],
        [-116.522, 41.071],
        [-116.565, 41.071],
        [-116.565, 41.038],
      ],
    ],
  };

  return {
    firms: {
      mode: "fixture",
      status: "ok",
      source: "NASA FIRMS fixture",
      fetchedAt,
      observedAt: latest,
      data: { detections },
    },
    nws: {
      mode: "fixture",
      status: "ok",
      source: "NWS fixture",
      fetchedAt,
      observedAt: weatherObservedAt,
      data: {
        weather: {
          windSpeedMps: 7.2,
          windFromDeg: 238,
          relativeHumidityPct: 17,
          humidityPercent: 17,
          quality: "direct-fresh",
          observedAt: weatherObservedAt,
        },
      },
    },
    airnow: {
      mode: "fixture",
      status: "ok",
      source: "AirNow fixture",
      fetchedAt,
      observedAt: shifted(now, 60),
      data: {
        air: {
          pm25UgM3: null,
          aqi: 71,
          quality: "direct-fresh",
          observedAt: shifted(now, 60),
        },
      },
    },
    wfigs: {
      mode: "fixture",
      status: "ok",
      source: "WFIGS fixture",
      fetchedAt,
      observedAt: officialUpdatedAt,
      data: {
        incidents: [
          {
            id: "fixture-antelope-creek",
            irwinId: "fixture-irwin-antelope",
            name: "Antelope Creek (fixture)",
            type: "WF",
            location: { lat: 41.049033, lon: -116.543867 },
            acres: 2512,
            percentContained: 35,
            discoveredAt: shifted(now, 18 * 60),
            updatedAt: officialUpdatedAt,
          },
        ],
        perimeters: [
          {
            id: "fixture-antelope-perimeter",
            sourceGlobalId: "fixture-antelope-creek",
            irwinId: "fixture-irwin-antelope",
            name: "Antelope Creek (fixture)",
            type: "WF",
            acres: 2512,
            percentContained: 35,
            currentAt: officialUpdatedAt,
            polygonAt: officialUpdatedAt,
            updatedAt: officialUpdatedAt,
            geometry,
          },
        ],
      },
    },
  };
}
