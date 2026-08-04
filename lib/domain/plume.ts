// Plume corridor geometry.
//
// Turns a smoke-advection estimate into map features: the wedge of ground the
// plume can travel over, and where its leading edge should be after each hour.
//
// Pure GeoJSON construction — no map library, no React — so the shapes drawn on
// screen are the same shapes a test can assert on. Distances use the same
// spherical model as lib/domain/geometry.

import { ADVECTION_BIAS_HOURS } from "./smoke";
import type { Coordinate } from "./types";

const EARTH_RADIUS_KM = 6_371.0088;

/** Furthest hour drawn as an isochrone. Beyond this the arcs stop being legible. */
export const MAX_ISOCHRONE_HOURS = 8;

export interface PlumePolygon {
  type: "Feature";
  properties: Record<string, never>;
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
}

export interface IsochroneCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { hour: number; distanceKm: number };
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }>;
}

/**
 * Point reached by travelling `distanceKm` along `bearingDeg` from an origin.
 * Returned as [lon, lat] to match GeoJSON coordinate order.
 */
export function destinationPoint(
  origin: Coordinate,
  bearingDeg: number,
  distanceKm: number,
): [number, number] {
  const angular = Math.max(0, distanceKm) / EARTH_RADIUS_KM;
  const bearing = (bearingDeg * Math.PI) / 180;
  const originLat = (origin.lat * Math.PI) / 180;
  const originLon = (origin.lon * Math.PI) / 180;
  const destinationLat = Math.asin(
    Math.sin(originLat) * Math.cos(angular) +
      Math.cos(originLat) * Math.sin(angular) * Math.cos(bearing),
  );
  const destinationLon =
    originLon +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(originLat),
      Math.cos(angular) - Math.sin(originLat) * Math.sin(destinationLat),
    );
  return [
    (destinationLon * 180) / Math.PI,
    (destinationLat * 180) / Math.PI,
  ];
}

/**
 * The corridor wedge, apex at the detection centroid, opening along the
 * transport bearing to `halfWidthDeg` either side.
 */
export function corridorFeature(
  origin: Coordinate,
  transportBearingDeg: number,
  halfWidthDeg: number,
  rangeKm: number,
  steps = 40,
): PlumePolygon {
  const arc = Array.from({ length: steps + 1 }, (_, index) =>
    destinationPoint(
      origin,
      transportBearingDeg - halfWidthDeg + (index / steps) * halfWidthDeg * 2,
      rangeKm,
    ),
  );
  const apex: [number, number] = [origin.lon, origin.lat];
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[apex, ...arc, apex]] },
  };
}

/**
 * Hourly smoke-front positions across the corridor.
 *
 * Uses the *calibrated* transit relationship, not raw advection. The estimator
 * adds ADVECTION_BIAS_HOURS to every transit, so an arc drawn at raw
 * `windSpeed * hour` would place the front further out than the panel says it
 * can be — the map would contradict the arrival time beside it.
 *
 * Inverting the estimator: transit(d) = d / (v * 3.6) + bias, so the front at
 * elapsed time t sits at d = (t - bias) * v * 3.6. Before the bias elapses
 * there is no front to draw, which is why the early hours are absent rather
 * than clamped to the origin.
 *
 * Arcs beyond `rangeKm` are likewise omitted rather than clamped, so the map
 * never implies the estimate reaches further than it does.
 */
export function isochroneFeatures(
  origin: Coordinate,
  transportBearingDeg: number,
  halfWidthDeg: number,
  windSpeedMps: number,
  rangeKm: number,
  steps = 28,
  biasHours = ADVECTION_BIAS_HOURS,
): IsochroneCollection {
  const perHourKm = Math.max(0, windSpeedMps) * 3.6;
  const features: IsochroneCollection["features"] = [];
  if (perHourKm <= 0) return { type: "FeatureCollection", features };
  for (let hour = 1; hour <= MAX_ISOCHRONE_HOURS; hour += 1) {
    const elapsedAfterBias = hour - biasHours;
    // The plume has not cleared the calibration delay yet.
    if (elapsedAfterBias <= 0) continue;
    const distanceKm = elapsedAfterBias * perHourKm;
    if (distanceKm > rangeKm) break;
    features.push({
      type: "Feature",
      properties: { hour, distanceKm },
      geometry: {
        type: "LineString",
        coordinates: Array.from({ length: steps + 1 }, (_, index) =>
          destinationPoint(
            origin,
            transportBearingDeg -
              halfWidthDeg +
              (index / steps) * halfWidthDeg * 2,
            distanceKm,
          ),
        ),
      },
    });
  }
  return { type: "FeatureCollection", features };
}
