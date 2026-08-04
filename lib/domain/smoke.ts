// Smoke advection estimates.
//
// EmberField deliberately does not predict fire spread. This module solves a
// narrower and far more tractable problem: given a heat detection that already
// exists and the wind measured near it, when does that plume reach a saved
// asset downwind?
//
// The estimate is straight-line advection — distance divided by wind speed,
// gated on whether the asset actually sits within the plume corridor. It is a
// crude approximation of a Lagrangian transport model such as HYSPLIT, and it
// is stated as such everywhere it surfaces.
//
// Calibration basis (see tests/smoke.test.ts):
//   Camp Fire, 8 November 2018. Ignition 39.794 N, 121.606 W at 14:30 UTC.
//   NASA POWER reported 10.0 m/s 50 m wind from 060 deg, so transport ran
//   toward 240 deg. Observed arrival was taken from EPA AirData hourly PM2.5
//   as the first hour each monitor exceeded three times its own pre-fire
//   baseline. Across 14 California monitors between 104 km and 262 km:
//
//     raw advection        median  +1.4 h   mean |error|  2.3 h
//     after correction     median  +0.0 h   mean |error|  1.6 h
//
//   After correction no monitor was warned more than 2.2 h late, and both
//   remaining large errors are early rather than late — the model told those
//   sites to expect smoke before it actually reached them. Two of the fourteen
//   are badly wrong regardless (9.8 h and 3.8 h early, both attributable to
//   coastal-range terrain channelling), so this must never be presented as a
//   warning system.

import { angleDifference, bearingDegrees, distanceKm } from "./geometry";
import type { Coordinate } from "./types";

/**
 * Median lateness of raw advection against observed PM2.5 arrival, in hours.
 * Applied as an additive correction. Derived from the Camp Fire validation
 * described above; a single well-observed event, not a fitted model.
 */
export const ADVECTION_BIAS_HOURS = 1.4;

/**
 * Half-width of the plume corridor, in degrees off the transport bearing.
 *
 * Validation monitors 45-50 degrees off axis still recorded severe smoke, so a
 * narrow cone would have discarded true positives — San Francisco sat 43
 * degrees off the Camp Fire transport bearing and reached 140 ug/m3.
 */
export const PLUME_HALF_WIDTH_DEG = 50;

/** Below this wind speed the transport direction is not meaningful. */
export const MIN_TRANSPORT_WIND_MPS = 1;

/** Beyond this range the estimate is outside anything we have checked. */
export const MAX_VALIDATED_RANGE_KM = 300;

export type SmokeArrivalStatus =
  | "inbound"
  | "likely-arrived"
  | "off-plume"
  | "calm-wind"
  | "beyond-range"
  | "insufficient-data";

export type SmokeArrivalConfidence = "none" | "low" | "moderate";

export interface SmokeArrivalInput {
  /** The saved asset we are estimating arrival for. */
  asset: Coordinate;
  /** Centroid of the detection cluster acting as the smoke source. */
  source: Coordinate;
  /** When the source detection was observed, ISO 8601. */
  detectedAt: string;
  /** Wind direction the wind blows *from*, degrees clockwise from north. */
  windFromDeg: number | null;
  /** Wind speed in metres per second. */
  windSpeedMps: number | null;
  /** Evaluation instant. */
  now: Date;
}

export interface SmokeArrival {
  status: SmokeArrivalStatus;
  confidence: SmokeArrivalConfidence;
  distanceKm: number;
  /** Bearing from the source to the asset. */
  assetBearingDeg: number;
  /** Bearing the wind pushes smoke toward, or null when wind is unusable. */
  transportBearingDeg: number | null;
  /** How far the asset sits off the transport axis. */
  offAxisDeg: number | null;
  /** Raw advection transit time before bias correction. */
  rawTransitHours: number | null;
  /** Bias-corrected transit time. */
  transitHours: number | null;
  /** Estimated arrival instant, ISO 8601. */
  estimatedArrivalAt: string | null;
  /** Hours from `now` until arrival. Negative once the estimate has passed. */
  hoursUntilArrival: number | null;
  missingData: string[];
  /** Plain-language basis for the estimate, safe to surface verbatim. */
  basis: string;
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Estimate when a detected plume reaches an asset.
 *
 * Pure and deterministic. Every branch returns a populated `missingData` list
 * rather than silently substituting zero, matching the gating discipline the
 * rest of the scoring engine uses.
 */
export function estimateSmokeArrival(input: SmokeArrivalInput): SmokeArrival {
  const distance = distanceKm(input.source, input.asset);
  const assetBearing = bearingDegrees(input.source, input.asset);
  const detectedAtMs = Date.parse(input.detectedAt);

  const missingData: string[] = [];
  if (input.windSpeedMps === null) missingData.push("wind-speed");
  if (input.windFromDeg === null) missingData.push("wind-direction");
  if (!Number.isFinite(detectedAtMs)) missingData.push("detection-time");

  const base = {
    distanceKm: round(distance, 1),
    assetBearingDeg: round(assetBearing, 0),
    transportBearingDeg: null,
    offAxisDeg: null,
    rawTransitHours: null,
    transitHours: null,
    estimatedArrivalAt: null,
    hoursUntilArrival: null,
    missingData,
  } satisfies Omit<SmokeArrival, "status" | "confidence" | "basis">;

  if (missingData.length > 0) {
    return {
      ...base,
      status: "insufficient-data",
      confidence: "none",
      basis: `Cannot estimate arrival: missing ${missingData.join(", ")}.`,
    };
  }

  const windSpeed = input.windSpeedMps as number;
  const windFrom = input.windFromDeg as number;

  if (windSpeed < MIN_TRANSPORT_WIND_MPS) {
    return {
      ...base,
      status: "calm-wind",
      confidence: "none",
      basis:
        `Wind is ${round(windSpeed, 1)} m/s, below the ` +
        `${MIN_TRANSPORT_WIND_MPS} m/s floor where a transport direction is meaningful. ` +
        `Smoke may accumulate near the source instead of travelling.`,
    };
  }

  // Meteorological convention reports the direction wind comes *from*; smoke
  // travels toward the opposite bearing.
  const transportBearing = (windFrom + 180) % 360;
  const offAxis = angleDifference(assetBearing, transportBearing);

  const withGeometry = {
    ...base,
    transportBearingDeg: round(transportBearing, 0),
    offAxisDeg: round(offAxis, 0),
  };

  if (offAxis > PLUME_HALF_WIDTH_DEG) {
    return {
      ...withGeometry,
      status: "off-plume",
      confidence: "low",
      basis:
        `Asset sits ${round(offAxis, 0)} deg off the transport bearing of ` +
        `${round(transportBearing, 0)} deg, outside the ` +
        `${PLUME_HALF_WIDTH_DEG} deg corridor. Smoke is not currently heading this way.`,
    };
  }

  const rawTransitHours = distance / (windSpeed * 3.6);
  const transitHours = rawTransitHours + ADVECTION_BIAS_HOURS;
  // Rounded to the second. Millisecond precision on an estimate whose mean
  // absolute error is 1.6 hours would be false precision, and it reads as a
  // confidence the method does not have.
  const arrivalMs =
    Math.round((detectedAtMs + transitHours * 3_600_000) / 1_000) * 1_000;
  const hoursUntilArrival = (arrivalMs - input.now.getTime()) / 3_600_000;

  // Confidence never exceeds "moderate". One validated event does not justify
  // a stronger claim, and two of fourteen monitors were badly wrong.
  const beyondRange = distance > MAX_VALIDATED_RANGE_KM;
  const confidence: SmokeArrivalConfidence =
    beyondRange || offAxis > 30 ? "low" : "moderate";

  const status: SmokeArrivalStatus = beyondRange
    ? "beyond-range"
    : hoursUntilArrival <= 0
      ? "likely-arrived"
      : "inbound";

  const rangeCaveat = beyondRange
    ? ` Range exceeds the ${MAX_VALIDATED_RANGE_KM} km validated envelope.`
    : "";

  return {
    ...withGeometry,
    status,
    confidence,
    rawTransitHours: round(rawTransitHours, 1),
    transitHours: round(transitHours, 1),
    estimatedArrivalAt: new Date(arrivalMs).toISOString(),
    hoursUntilArrival: round(hoursUntilArrival, 1),
    basis:
      `${round(distance, 0)} km downwind at ${round(offAxis, 0)} deg off the ` +
      `${round(transportBearing, 0)} deg transport bearing, with ` +
      `${round(windSpeed, 1)} m/s wind. Straight-line advection gives ` +
      `${round(rawTransitHours, 1)} h, corrected to ${round(transitHours, 1)} h ` +
      `using the +${ADVECTION_BIAS_HOURS} h median lateness measured against ` +
      `EPA monitors during the 2018 Camp Fire. This is an advection estimate, ` +
      `not a fire-spread prediction.${rangeCaveat}`,
  };
}
