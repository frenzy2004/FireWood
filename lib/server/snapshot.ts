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
  limits?: SnapshotLimitState;
}

export const SNAPSHOT_LIMITS = {
  detections: 1_500,
  groups: 100,
  incidents: 250,
  perimeters: 100,
  perimeterCoordinates: 50_000,
  weatherConcurrency: 4,
} as const;

export interface SnapshotLimitState {
  exactRadiusApplied: true;
  truncated: Array<"detections" | "groups" | "incidents" | "perimeters">;
  alertsAutomated: boolean;
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

const partialWhenTruncated = (
  state: SnapshotSourceState,
  truncated: boolean,
): SnapshotSourceState =>
  truncated && state.status === "ok" ? { ...state, status: "partial" } : state;

const coordinateCount = (value: unknown): number => {
  if (!Array.isArray(value)) return 0;
  if (
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    return 1;
  }
  return value.reduce((count, child) => count + coordinateCount(child), 0);
};

function boundedPerimeters(perimeters: WfigsPerimeter[]): WfigsPerimeter[] {
  const bounded: WfigsPerimeter[] = [];
  let coordinates = 0;
  for (const perimeter of perimeters) {
    if (bounded.length >= SNAPSHOT_LIMITS.perimeters) break;
    const candidateCoordinates = coordinateCount(perimeter.geometry.coordinates);
    if (coordinates + candidateCoordinates > SNAPSHOT_LIMITS.perimeterCoordinates) {
      break;
    }
    coordinates += candidateCoordinates;
    bounded.push(perimeter);
  }
  return bounded;
}

async function settleWithConcurrency<T, R>(
  values: T[],
  maximumConcurrent: number,
  worker: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(maximumConcurrent, values.length) },
    async () => {
      while (cursor < values.length) {
        signal?.throwIfAborted();
        const index = cursor;
        cursor += 1;
        try {
          results[index] = {
            status: "fulfilled",
            value: await worker(values[index], index),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  signal?.throwIfAborted();
  return results;
}

const disabledAutomation = (group: SnapshotGroup): SnapshotGroup => ({
  ...group,
  assessment: {
    ...group.assessment,
    dataConfidence: Math.min(59, group.assessment.dataConfidence),
    dataQuality: "limited",
    completeness:
      group.assessment.completeness === "complete"
        ? "partial"
        : group.assessment.completeness,
    canAutomateAlerts: false,
  },
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

function perimeterRings(geometry: WfigsGeometry): number[][][] {
  return geometry.type === "Polygon"
    ? geometry.coordinates
    : geometry.coordinates.flatMap((polygon) => polygon);
}

function segmentDistanceKm(
  point: { lat: number; lon: number },
  left: number[],
  right: number[],
): number {
  const latitudeScale = 111.32;
  const longitudeScale =
    latitudeScale * Math.cos((point.lat * Math.PI) / 180);
  const leftX = (left[0] - point.lon) * longitudeScale;
  const leftY = (left[1] - point.lat) * latitudeScale;
  const deltaX = (right[0] - left[0]) * longitudeScale;
  const deltaY = (right[1] - left[1]) * latitudeScale;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  const fraction = squaredLength === 0
    ? 0
    : Math.max(
        0,
        Math.min(1, -(leftX * deltaX + leftY * deltaY) / squaredLength),
      );
  return Math.hypot(
    leftX + fraction * deltaX,
    leftY + fraction * deltaY,
  );
}

export function geometryIntersectsRadius(
  point: { lat: number; lon: number },
  radiusKm: number,
  geometry: WfigsGeometry,
): boolean {
  if (geometryContains(point, geometry)) return true;
  return perimeterRings(geometry).some((ring) =>
    ring.some((coordinate, index) => {
      const next = ring[(index + 1) % ring.length];
      return Boolean(next) && segmentDistanceKm(point, coordinate, next) <= radiusKm;
    }),
  );
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
  const nowMs = now.getTime();
  const cutoffMs = nowMs - 24 * 60 * 60 * 1_000;
  const distinctPasses24h = new Set(
    cluster.detections.flatMap((detection) => {
      const acquiredAtMs = Date.parse(detection.acquiredAt);
      return acquiredAtMs >= cutoffMs && acquiredAtMs <= nowMs
        ? [`${detection.satellite}:${detection.acquiredAt}`]
        : [];
    }),
  ).size;

  return assessCluster({
    assetId: asset.id,
    clusterId: cluster.id,
    distanceKm: distanceKm(asset.location, cluster.centroid),
    ageHours: Math.max(0, (now.getTime() - Date.parse(cluster.latestAcquiredAt)) / 3_600_000),
    confidence: cluster.maxConfidence,
    frpMw: cluster.maxFrpMw,
    distinctPasses24h,
    bearingClusterToAsset: bearingDegrees(cluster.centroid, asset.location),
    weather,
    air,
  });
}

function fixtureSnapshot(input: BuildSnapshotInput, now: Date): Snapshot {
  const fixture = createDemoFixture(now);
  const bbox = input.bbox ?? boundingBox(input.asset.location, input.asset.radiusKm);
  const detections = fixture.firms.data.detections
    .filter(
      (detection) =>
        distanceKm(input.asset.location, detection) <= input.asset.radiusKm,
    )
    .slice(0, SNAPSHOT_LIMITS.detections);
  const clusters = clusterDetections(detections, {
    maxDistanceKm: 1.5,
    maxGapHours: 6,
  }).slice(0, SNAPSHOT_LIMITS.groups);
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
    detections,
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
    limits: {
      exactRadiusApplied: true,
      truncated: [],
      alertsAutomated: true,
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
  const radiusDetections = (firms?.detections ?? []).filter(
    (detection) =>
      distanceKm(input.asset.location, detection) <= input.asset.radiusKm,
  );
  const detections = radiusDetections.slice(0, SNAPSHOT_LIMITS.detections);
  const air = airPayload?.air ?? null;
  const radiusIncidents = (wfigs?.incidents ?? []).filter(
    (incident) =>
      distanceKm(input.asset.location, incident.location) <= input.asset.radiusKm,
  );
  const incidents = radiusIncidents.slice(0, SNAPSHOT_LIMITS.incidents);
  const rawPerimeters = wfigs?.perimeters ?? [];
  const radiusPerimeters = rawPerimeters.filter((perimeter) =>
    geometryIntersectsRadius(
      input.asset.location,
      input.asset.radiusKm,
      perimeter.geometry,
    ),
  );
  const perimeters = boundedPerimeters(radiusPerimeters);
  const allClusters = clusterDetections(detections, {
    maxDistanceKm: 1.5,
    maxGapHours: 6,
  });
  const clusters = allClusters.slice(0, SNAPSHOT_LIMITS.groups);
  const truncated: SnapshotLimitState["truncated"] = [];
  if (radiusDetections.length > detections.length) truncated.push("detections");
  if (allClusters.length > clusters.length) truncated.push("groups");
  if (radiusIncidents.length > incidents.length) truncated.push("incidents");
  if (radiusPerimeters.length > perimeters.length) truncated.push("perimeters");
  const sourcePagesComplete =
    firms?.status !== "partial" && wfigs?.status !== "partial";

  const fetchWeather = dependencies.fetchWeather ?? fetchWeatherContext;
  const weatherResults = await settleWithConcurrency(
    clusters,
    SNAPSHOT_LIMITS.weatherConcurrency,
    (cluster) =>
      fetchWeather({
        location: cluster.centroid,
        at: new Date(cluster.latestAcquiredAt),
      }, adapterDependencies),
    dependencies.signal,
  );
  dependencies.signal?.throwIfAborted();
  const weatherSuccesses = weatherResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const alertsAutomated =
    truncated.length === 0 &&
    sourcePagesComplete &&
    weatherSuccesses.length === weatherResults.length;
  const groups = clusters.map((cluster, index) => {
    const result = weatherResults[index];
    const weather = result?.status === "fulfilled" ? result.value.weather : null;
    const group = {
      cluster,
      weather,
      assessment: assessmentFor(input.asset, cluster, weather, air, now),
      officialMatch: matchIncident(cluster, incidents, perimeters),
    };
    return alertsAutomated ? group : disabledAutomation(group);
  });
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
        ? partialWhenTruncated(
            sourceState(firms),
            truncated.includes("detections") || truncated.includes("groups"),
          )
        : sourceError("live", "NASA FIRMS", generatedAt),
      nws: nwsState,
      airnow: airPayload
        ? sourceState(airPayload)
        : sourceError("live", "AirNow", generatedAt),
      wfigs: wfigs
        ? partialWhenTruncated(
            sourceState(wfigs),
            truncated.includes("incidents") || truncated.includes("perimeters"),
          )
        : sourceError("live", "WFIGS", generatedAt),
    },
    limits: {
      exactRadiusApplied: true,
      truncated,
      alertsAutomated,
    },
  };
}
