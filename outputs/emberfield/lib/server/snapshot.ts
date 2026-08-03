import { clusterDetections } from "../domain/cluster";
import { bearingDegrees, boundingBox, distanceKm } from "../domain/geometry";
import { assessCluster } from "../domain/score";
import type {
  ActivityCluster,
  AirQualityContext,
  Asset,
  Assessment,
  BoundingBox,
  Detection,
  WeatherContext,
} from "../domain/types";
import { createDemoFixture } from "../fixtures/demo";
import {
  fetchAirQuality,
  type AirQualityPayload,
} from "../sources/airnow";
import {
  fetchFirmsDetections,
  type FirmsPayload,
} from "../sources/firms";
import {
  fetchWeatherContext,
  type WeatherPayload,
} from "../sources/nws";
import type { DataMode } from "../sources/shared";
import {
  fetchWfigs,
  type WfigsGeometry,
  type WfigsIncident,
  type WfigsPayload,
  type WfigsPerimeter,
} from "../sources/wfigs";
import { getRuntimeConfig, type RuntimeConfig } from "./config";
import { sourceCache, type TtlCache } from "./cache";

export type SnapshotSourceStatus =
  | "ok"
  | "partial"
  | "missing-key"
  | "error"
  | "not-requested";

export interface SnapshotSourceCoverage {
  succeeded: number;
  failed: number;
  total: number;
}

export interface SnapshotSourceState {
  mode: DataMode;
  status: SnapshotSourceStatus;
  source: string;
  sourceUrl: string | null;
  sourceUrls?: string[];
  coverage?: SnapshotSourceCoverage;
  fetchedAt: string;
  observedAt: string | null;
  error?: { code: string; message: string };
}

export interface OfficialMatch {
  incident: WfigsIncident;
  method: "perimeter" | "proximity";
  distanceKm: number;
  perimeterId: string | null;
}

export interface SnapshotGroup {
  cluster: ActivityCluster;
  weather: WeatherContext | null;
  assessment: Assessment;
  officialMatch: OfficialMatch | null;
}

export interface Snapshot {
  mode: DataMode;
  generatedAt: string;
  asset: Asset;
  bbox: BoundingBox;
  detections: Detection[];
  groups: SnapshotGroup[];
  incidents: WfigsIncident[];
  perimeters: WfigsPerimeter[];
  air: AirQualityContext | null;
  sources: {
    firms: SnapshotSourceState;
    nws: SnapshotSourceState;
    airnow: SnapshotSourceState;
    wfigs: SnapshotSourceState;
  };
}

export interface BuildSnapshotInput {
  asset: Asset;
  bbox?: BoundingBox;
  mode?: DataMode;
}

export interface SnapshotDependencies {
  now?: () => Date;
  config?: RuntimeConfig;
  environment?: Record<string, string | undefined>;
  fetchFirms?: typeof fetchFirmsDetections;
  fetchWeather?: typeof fetchWeatherContext;
  fetchAir?: typeof fetchAirQuality;
  fetchWfigs?: typeof fetchWfigs;
  cache?: TtlCache;
  signal?: AbortSignal;
  refresh?: boolean;
}

const sourceError = (
  mode: DataMode,
  source: string,
  fetchedAt: string,
): SnapshotSourceState => ({
  mode,
  status: "error",
  source,
  sourceUrl: null,
  fetchedAt,
  observedAt: null,
  error: { code: "unavailable", message: `${source} data is unavailable` },
});

function safeSourceUrl(source: string, candidate: string | undefined): string | null {
  if (!candidate || source === "NASA FIRMS" || source === "AirNow") return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

const sourceState = (
  payload: Pick<
    FirmsPayload | WeatherPayload | AirQualityPayload | WfigsPayload,
    "mode" | "status" | "source" | "fetchedAt" | "observedAt"
  > & { sourceUrl?: string },
): SnapshotSourceState => ({
  mode: payload.mode,
  status: payload.status,
  source: payload.source,
  sourceUrl: safeSourceUrl(payload.source, payload.sourceUrl),
  fetchedAt: payload.fetchedAt,
  observedAt: payload.observedAt,
});

function ringContains(point: { lat: number; lon: number }, ring: number[][]): boolean {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const currentPoint = ring[current];
    const previousPoint = ring[previous];
    if (!currentPoint || !previousPoint) continue;
    const [currentLon, currentLat] = currentPoint;
    const [previousLon, previousLat] = previousPoint;
    const crosses =
      currentLat > point.lat !== previousLat > point.lat &&
      point.lon <
        ((previousLon - currentLon) * (point.lat - currentLat)) /
          (previousLat - currentLat) +
          currentLon;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonContains(
  point: { lat: number; lon: number },
  polygon: number[][][],
): boolean {
  if (!polygon[0] || !ringContains(point, polygon[0])) return false;
  return polygon.slice(1).every((hole) => !ringContains(point, hole));
}

export function geometryContains(
  point: { lat: number; lon: number },
  geometry: WfigsGeometry,
): boolean {
  return geometry.type === "Polygon"
    ? polygonContains(point, geometry.coordinates)
    : geometry.coordinates.some((polygon) => polygonContains(point, polygon));
}

function matchIncident(
  cluster: ActivityCluster,
  incidents: WfigsIncident[],
  perimeters: WfigsPerimeter[],
): OfficialMatch | null {
  for (const perimeter of perimeters) {
    if (!geometryContains(cluster.centroid, perimeter.geometry)) continue;
    const incident = incidents.find(
      (candidate) =>
        (perimeter.irwinId && candidate.irwinId === perimeter.irwinId) ||
        candidate.id === perimeter.sourceGlobalId,
    );
    if (incident) {
      return {
        incident,
        method: "perimeter",
        distanceKm: distanceKm(cluster.centroid, incident.location),
        perimeterId: perimeter.id,
      };
    }
  }

  const nearby = incidents
    .map((incident) => ({
      incident,
      distanceKm: distanceKm(cluster.centroid, incident.location),
    }))
    .filter(({ distanceKm: distance }) => distance <= 10)
    .sort((left, right) => left.distanceKm - right.distanceKm)[0];
  return nearby
    ? {
        ...nearby,
        method: "proximity",
        perimeterId: null,
      }
    : null;
}

function assessmentFor(
  asset: Asset,
  cluster: ActivityCluster,
  weather: WeatherContext | null,
  air: AirQualityContext | null,
  now: Date,
): Assessment {
  return assessCluster({
    assetId: asset.id,
    clusterId: cluster.id,
    distanceKm: distanceKm(asset.location, cluster.centroid),
    ageHours: Math.max(0, (now.getTime() - Date.parse(cluster.latestAcquiredAt)) / 3_600_000),
    confidence: cluster.maxConfidence,
    frpMw: cluster.maxFrpMw,
    distinctPasses24h: cluster.satellites.length,
    bearingClusterToAsset: bearingDegrees(cluster.centroid, asset.location),
    weather,
    air,
  });
}

function fixtureSnapshot(input: BuildSnapshotInput, now: Date): Snapshot {
  const fixture = createDemoFixture(now);
  const bbox = input.bbox ?? boundingBox(input.asset.location, input.asset.radiusKm);
  const clusters = clusterDetections(fixture.firms.data.detections, {
    maxDistanceKm: 1.5,
    maxGapHours: 6,
  });
  const groups = clusters.map((cluster) => {
    const weather = fixture.nws.data.weather;
    return {
      cluster,
      weather,
      assessment: assessmentFor(input.asset, cluster, weather, fixture.airnow.data.air, now),
      officialMatch: matchIncident(
        cluster,
        fixture.wfigs.data.incidents,
        fixture.wfigs.data.perimeters,
      ),
    };
  });
  const toState = (source: { mode: "fixture"; status: "ok"; source: string; fetchedAt: string; observedAt: string | null }): SnapshotSourceState => ({
    mode: source.mode,
    status: source.status,
    source: source.source,
    sourceUrl: null,
    fetchedAt: source.fetchedAt,
    observedAt: source.observedAt,
  });
  return {
    mode: "fixture",
    generatedAt: now.toISOString(),
    asset: input.asset,
    bbox,
    detections: fixture.firms.data.detections,
    groups,
    incidents: fixture.wfigs.data.incidents,
    perimeters: fixture.wfigs.data.perimeters,
    air: fixture.airnow.data.air,
    sources: {
      firms: toState(fixture.firms),
      nws: {
        ...toState(fixture.nws),
        coverage: {
          succeeded: groups.length,
          failed: 0,
          total: groups.length,
        },
      },
      airnow: toState(fixture.airnow),
      wfigs: toState(fixture.wfigs),
    },
  };
}

export async function buildSnapshot(
  input: BuildSnapshotInput,
  dependencies: SnapshotDependencies = {},
): Promise<Snapshot> {
  dependencies.signal?.throwIfAborted();
  const now = dependencies.now?.() ?? new Date();
  if ((input.mode ?? "live") === "fixture") return fixtureSnapshot(input, now);

  const bbox = input.bbox ?? boundingBox(input.asset.location, input.asset.radiusKm);
  const config = dependencies.config ?? getRuntimeConfig(dependencies.environment);
  const fetchFirms = dependencies.fetchFirms ?? fetchFirmsDetections;
  const fetchAir = dependencies.fetchAir ?? fetchAirQuality;
  const fetchOfficial = dependencies.fetchWfigs ?? fetchWfigs;
  const cache = dependencies.cache ?? sourceCache;
  const adapterDependencies = {
    cache,
    now: dependencies.now,
    signal: dependencies.signal,
    refresh: dependencies.refresh,
  };
  const [firmsResult, airResult, wfigsResult] = await Promise.allSettled([
    fetchFirms({ mapKey: config.firms.mapKey, bbox }, adapterDependencies),
    fetchAir(
      { apiKey: config.airnow.apiKey, location: input.asset.location },
      adapterDependencies,
    ),
    fetchOfficial({ bbox }, adapterDependencies),
  ]);
  dependencies.signal?.throwIfAborted();

  const firms = firmsResult.status === "fulfilled" ? firmsResult.value : null;
  const airPayload = airResult.status === "fulfilled" ? airResult.value : null;
  const wfigs = wfigsResult.status === "fulfilled" ? wfigsResult.value : null;
  const detections = firms?.detections ?? [];
  const air = airPayload?.air ?? null;
  const incidents = wfigs?.incidents ?? [];
  const perimeters = wfigs?.perimeters ?? [];
  const clusters = clusterDetections(detections, {
    maxDistanceKm: 1.5,
    maxGapHours: 6,
  });

  const fetchWeather = dependencies.fetchWeather ?? fetchWeatherContext;
  const weatherResults = await Promise.allSettled(
    clusters.map((cluster) =>
      fetchWeather({
        location: cluster.centroid,
        at: new Date(cluster.latestAcquiredAt),
      }, adapterDependencies),
    ),
  );
  dependencies.signal?.throwIfAborted();
  const groups = clusters.map((cluster, index) => {
    const result = weatherResults[index];
    const weather = result?.status === "fulfilled" ? result.value.weather : null;
    return {
      cluster,
      weather,
      assessment: assessmentFor(input.asset, cluster, weather, air, now),
      officialMatch: matchIncident(cluster, incidents, perimeters),
    };
  });
  const weatherSuccesses = weatherResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const weatherCoverage: SnapshotSourceCoverage = {
    succeeded: weatherSuccesses.length,
    failed: weatherResults.length - weatherSuccesses.length,
    total: weatherResults.length,
  };
  const weatherSourceUrls = [
    ...new Set(
      weatherSuccesses.flatMap(({ source, sourceUrl }) => {
        const safeUrl = safeSourceUrl(source, sourceUrl);
        return safeUrl ? [safeUrl] : [];
      }),
    ),
  ];
  const generatedAt = now.toISOString();
  const nwsState: SnapshotSourceState =
    clusters.length === 0
      ? {
          mode: "live",
          status: "not-requested",
          source: "NWS",
          sourceUrl: null,
          sourceUrls: [],
          coverage: weatherCoverage,
          fetchedAt: generatedAt,
          observedAt: null,
        }
      : weatherSuccesses.length > 0
        ? {
            mode: "live",
            status:
              weatherSuccesses.length === weatherResults.length
                ? "ok"
                : "partial",
            source: "NWS",
            sourceUrl: weatherSourceUrls[0] ?? null,
            sourceUrls: weatherSourceUrls,
            coverage: weatherCoverage,
            fetchedAt: weatherSuccesses
              .map(({ fetchedAt }) => fetchedAt)
              .sort()
              .at(-1) ?? generatedAt,
            observedAt: weatherSuccesses
              .flatMap(({ observedAt }) => (observedAt ? [observedAt] : []))
              .sort()
              .at(-1) ?? null,
          }
        : {
            ...sourceError("live", "NWS", generatedAt),
            sourceUrls: [],
            coverage: weatherCoverage,
          };

  return {
    mode: "live",
    generatedAt,
    asset: input.asset,
    bbox,
    detections,
    groups,
    incidents,
    perimeters,
    air,
    sources: {
      firms: firms
        ? sourceState(firms)
        : sourceError("live", "NASA FIRMS", generatedAt),
      nws: nwsState,
      airnow: airPayload
        ? sourceState(airPayload)
        : sourceError("live", "AirNow", generatedAt),
      wfigs: wfigs
        ? sourceState(wfigs)
        : sourceError("live", "WFIGS", generatedAt),
    },
  };
}
