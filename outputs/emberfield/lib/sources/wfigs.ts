import type { BoundingBox, Coordinate } from "../domain/types";
import { CACHE_TTLS } from "../server/cache";
import {
  asRecord,
  boundedJson,
  fetchWithTimeout,
  finiteNumber,
  SourceAdapterError,
  utcNow,
  type AdapterDependencies,
} from "./shared";

const POINT_ENDPOINT = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
const PERIMETER_ENDPOINT = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";
const POINT_PAGE_SIZE = 500;
const PERIMETER_PAGE_SIZE = 100;
const POINT_RESPONSE_BYTES = 1_000_000;
const PERIMETER_RESPONSE_BYTES = 2_000_000;
const MAXIMUM_PERIMETER_COORDINATES = 10_000;
const MAXIMUM_LAYER_COORDINATES = 30_000;
// Each layer is intentionally limited to one bounded page. A full page is
// labeled partial instead of attempting an unbounded pagination sequence.
const MAXIMUM_PAGES = 1;

export const WFIGS_POINT_FIELDS = "OBJECTID,GlobalID,IrwinID,IncidentName,IncidentTypeCategory,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt";
export const WFIGS_PERIMETER_FIELDS = "OBJECTID,GlobalID,poly_SourceGlobalID,poly_IRWINID,poly_IncidentName,poly_GISAcres,poly_DateCurrent,poly_PolygonDateTime,attr_PercentContained,attr_IncidentTypeCategory,attr_ModifiedOnDateTime_dt";

export type WfigsGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface WfigsIncident {
  id: string;
  irwinId: string | null;
  name: string;
  type: string;
  location: Coordinate;
  acres: number | null;
  percentContained: number | null;
  discoveredAt: string | null;
  updatedAt: string | null;
}

export interface WfigsPerimeter {
  id: string;
  sourceGlobalId: string | null;
  irwinId: string | null;
  name: string;
  type: string;
  acres: number | null;
  percentContained: number | null;
  currentAt: string | null;
  polygonAt: string | null;
  updatedAt: string | null;
  geometry: WfigsGeometry;
}

export interface WfigsData {
  incidents: WfigsIncident[];
  perimeters: WfigsPerimeter[];
}

export interface WfigsPayload extends WfigsData {
  mode: "live";
  status: "ok" | "partial";
  source: "WFIGS";
  fetchedAt: string;
  observedAt: string | null;
}

const isoDate = (value: unknown): string | null => {
  const milliseconds = finiteNumber(value);
  if (milliseconds === null) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function featureCollection(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (record?.type !== "FeatureCollection" || !Array.isArray(record.features)) {
    throw new SourceAdapterError("WFIGS", "invalid-response", "WFIGS returned invalid GeoJSON");
  }
  return record.features.map((feature) => {
    const value = asRecord(feature);
    if (value === null) {
      throw new SourceAdapterError("WFIGS", "invalid-response", "WFIGS returned an invalid feature");
    }
    return value;
  });
}

export function parseWfigsGeoJson(
  payload: unknown,
  kind: "points" | "perimeters",
): WfigsData {
  const features = featureCollection(payload);
  const maximumFeatures = kind === "points" ? POINT_PAGE_SIZE : PERIMETER_PAGE_SIZE;
  if (features.length > maximumFeatures) {
    throw new SourceAdapterError(
      "WFIGS",
      "invalid-response",
      "WFIGS returned more features than requested",
    );
  }
  if (kind === "points") {
    return {
      incidents: features.map((feature) => {
        const properties = asRecord(feature.properties) ?? {};
        const geometry = asRecord(feature.geometry);
        const coordinates = Array.isArray(geometry?.coordinates)
          ? geometry.coordinates
          : [];
        const lon = finiteNumber(coordinates[0]);
        const lat = finiteNumber(coordinates[1]);
        if (geometry?.type !== "Point" || lat === null || lon === null) {
          throw new SourceAdapterError("WFIGS", "invalid-response", "WFIGS returned an invalid point");
        }
        return {
          id: String(properties.GlobalID ?? properties.OBJECTID ?? feature.id ?? ""),
          irwinId: properties.IrwinID == null ? null : String(properties.IrwinID),
          name: String(properties.IncidentName ?? "Unnamed incident"),
          type: String(properties.IncidentTypeCategory ?? ""),
          location: { lat, lon },
          acres: finiteNumber(properties.IncidentSize),
          percentContained: finiteNumber(properties.PercentContained),
          discoveredAt: isoDate(properties.FireDiscoveryDateTime),
          updatedAt: isoDate(properties.ModifiedOnDateTime_dt),
        };
      }),
      perimeters: [],
    };
  }

  let layerCoordinates = 0;
  const perimeters = features.map((feature) => {
      const properties = asRecord(feature.properties) ?? {};
      const geometry = asRecord(feature.geometry);
      if (
        (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") ||
        !Array.isArray(geometry.coordinates)
      ) {
        throw new SourceAdapterError("WFIGS", "invalid-response", "WFIGS returned an invalid perimeter");
      }
      let featureCoordinates = 0;
      const visit = (value: unknown): void => {
        if (!Array.isArray(value)) {
          throw new SourceAdapterError("WFIGS", "invalid-response", "WFIGS returned an invalid perimeter");
        }
        if (
          value.length >= 2 &&
          finiteNumber(value[0]) !== null &&
          finiteNumber(value[1]) !== null
        ) {
          featureCoordinates += 1;
          layerCoordinates += 1;
          if (featureCoordinates > MAXIMUM_PERIMETER_COORDINATES) {
            throw new SourceAdapterError(
              "WFIGS",
              "invalid-response",
              "WFIGS perimeter geometry exceeds the coordinate limit",
            );
          }
          if (layerCoordinates > MAXIMUM_LAYER_COORDINATES) {
            throw new SourceAdapterError(
              "WFIGS",
              "invalid-response",
              "WFIGS perimeter layer exceeds the coordinate limit",
            );
          }
          return;
        }
        for (const child of value) visit(child);
      };
      visit(geometry.coordinates);
      return {
        id: String(properties.GlobalID ?? properties.OBJECTID ?? feature.id ?? ""),
        sourceGlobalId:
          properties.poly_SourceGlobalID == null
            ? null
            : String(properties.poly_SourceGlobalID),
        irwinId:
          properties.poly_IRWINID == null
            ? null
            : String(properties.poly_IRWINID),
        name: String(properties.poly_IncidentName ?? "Unnamed incident"),
        type: String(properties.attr_IncidentTypeCategory ?? ""),
        acres: finiteNumber(properties.poly_GISAcres),
        percentContained: finiteNumber(properties.attr_PercentContained),
        currentAt: isoDate(properties.poly_DateCurrent),
        polygonAt: isoDate(properties.poly_PolygonDateTime),
        updatedAt: isoDate(properties.attr_ModifiedOnDateTime_dt),
        geometry: geometry as WfigsGeometry,
      };
    });
  return {
    incidents: [],
    perimeters,
  };
}

function queryUrl(
  endpoint: string,
  bbox: BoundingBox,
  fields: string,
  offset: number,
  pageSize: number,
): string {
  const url = new URL(endpoint);
  const parameters: Record<string, string> = {
    f: "geojson",
    where: "1=1",
    geometry: [bbox.west, bbox.south, bbox.east, bbox.north].join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "true",
    resultRecordCount: String(pageSize),
    resultOffset: String(offset),
    orderByFields: "OBJECTID ASC",
    outFields: fields,
  };
  Object.entries(parameters).forEach(([name, value]) => url.searchParams.set(name, value));
  return url.toString();
}

async function fetchLayer(
  endpoint: string,
  fields: string,
  kind: "points" | "perimeters",
  bbox: BoundingBox,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<WfigsData & { truncated: boolean }> {
  const combined: WfigsData = { incidents: [], perimeters: [] };
  let truncated = false;
  const pageSize = kind === "points" ? POINT_PAGE_SIZE : PERIMETER_PAGE_SIZE;
  const responseBytes = kind === "points"
    ? POINT_RESPONSE_BYTES
    : PERIMETER_RESPONSE_BYTES;
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const url = queryUrl(endpoint, bbox, fields, page * pageSize, pageSize);
    const response = await fetchWithTimeout(
      "WFIGS",
      url,
      { headers: { Accept: "application/geo+json" } },
      fetchImplementation,
      12_000,
      signal,
    );
    const payload = await boundedJson("WFIGS", response, responseBytes);
    const features = featureCollection(payload);
    const parsed = parseWfigsGeoJson(payload, kind);
    combined.incidents.push(...parsed.incidents);
    combined.perimeters.push(...parsed.perimeters);
    truncated = features.length >= pageSize;
    if (!truncated) break;
  }
  return { ...combined, truncated };
}

export async function fetchWfigs(
  input: { bbox: BoundingBox },
  dependencies: AdapterDependencies = {},
): Promise<WfigsPayload> {
  dependencies.signal?.throwIfAborted();
  if (input.bbox.crossesAntimeridian) {
    throw new SourceAdapterError("WFIGS", "invalid-bbox", "WFIGS requests cannot cross the antimeridian");
  }
  const envelope = [input.bbox.west, input.bbox.south, input.bbox.east, input.bbox.north].join(",");
  const load = async (): Promise<WfigsPayload> => {
    const fetchImplementation = dependencies.fetchImplementation ?? fetch;
    const [points, perimeters] = await Promise.all([
      fetchLayer(
        POINT_ENDPOINT,
        WFIGS_POINT_FIELDS,
        "points",
        input.bbox,
        fetchImplementation,
        dependencies.signal,
      ),
      fetchLayer(
        PERIMETER_ENDPOINT,
        WFIGS_PERIMETER_FIELDS,
        "perimeters",
        input.bbox,
        fetchImplementation,
        dependencies.signal,
      ),
    ]);
    const observedTimes = [
      ...points.incidents.flatMap(({ updatedAt }) => (updatedAt ? [updatedAt] : [])),
      ...perimeters.perimeters.flatMap(({ updatedAt }) => (updatedAt ? [updatedAt] : [])),
    ].sort();
    return {
      mode: "live",
      status: points.truncated || perimeters.truncated ? "partial" : "ok",
      source: "WFIGS",
      fetchedAt: utcNow(dependencies.now),
      observedAt: observedTimes.at(-1) ?? null,
      incidents: points.incidents,
      perimeters: perimeters.perimeters,
    };
  };
  return dependencies.cache
    ? (
        await dependencies.cache.getOrLoad(
          `wfigs:${envelope}`,
          CACHE_TTLS.wfigs,
          load,
          { signal: dependencies.signal, refresh: dependencies.refresh },
        )
      ).value
    : load();
}
