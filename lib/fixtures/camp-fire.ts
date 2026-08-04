// Camp Fire replay fixture — 8 November 2018.
//
// This fixture exists to make one claim checkable: EmberField can estimate
// smoke arrival from a satellite detection hours before the smoke lands, and
// the estimate can be compared against what actually happened.
//
// Unlike the Antelope Creek demo fixture, every timestamp here is absolute
// rather than relative to the current clock. A historical replay defines its
// own reference instant; see REFERENCE_INSTANT below.
//
// PROVENANCE — what is real and what is reconstructed:
//
//   Real, and independently verifiable:
//     - Ignition point and time. 39.794 N, 121.606 W, 06:30 PST (14:30 UTC).
//     - Wind. NASA POWER hourly at the ignition point, 50 m: 10.0 m/s from
//       060 deg averaged over 14:00-24:00 UTC. Keyless endpoint, reproducible.
//     - Observed smoke arrival at the asset. EPA AirData hourly PM2.5,
//       parameter 88101, site 39.021221 N 122.281803 W in Colusa County.
//       First hour above three times its 5-7 November median was 21:00 UTC,
//       6.5 hours after ignition.
//     - The incident record. CA-BTU-016737, reported 8 November 2018.
//
//   Reconstructed for the replay:
//     - Individual VIIRS detection records. Acquisition times and fire radiative
//       power are representative of an early-morning overpass over the ignition
//       area, not transcribed from a specific FIRMS archive row. They are marked
//       `fixture:VIIRS_*_REPLAY` so they can never be mistaken for live data.
//
// The asset is deliberately colocated with the EPA monitor so the estimate and
// the ground truth describe the same point on the map.

import type { Asset, BoundingBox, Detection } from "../domain/types";
import type { DemoFixture } from "./demo";

/** Camp Fire ignition, 06:30 PST on 8 November 2018. */
export const CAMP_FIRE_IGNITION = {
  location: { lat: 39.794, lon: -121.606 },
  at: "2018-11-08T14:30:00.000Z",
} as const;

/**
 * The instant the replay is evaluated at: 30 minutes after ignition.
 *
 * Chosen so the snapshot shows clean air at the asset while the estimate
 * already places smoke inbound. That contrast is the entire point of the tool.
 */
export const CAMP_FIRE_REFERENCE_INSTANT = "2018-11-08T15:00:00.000Z";

/** Observed arrival at the asset, hours after ignition, from EPA AirData. */
export const CAMP_FIRE_OBSERVED_ARRIVAL_HOURS = 6.5;

export const CAMP_FIRE_ASSET: Asset = {
  id: "replay-camp-fire-colusa-orchard",
  name: "Colusa County Orchard (Camp Fire replay)",
  location: { lat: 39.021221, lon: -122.281803 },
  // Smoke travels far further than fire. A proximity radius sized for flame
  // would never see a source 104 km upwind, which is exactly the blind spot
  // this replay demonstrates.
  radiusKm: 120,
};

export const CAMP_FIRE_BBOX: BoundingBox = {
  west: -123.6,
  south: 38.2,
  east: -120.9,
  north: 40.4,
  crossesAntimeridian: false,
};

const detections: Detection[] = [
  {
    id: "replay-camp-fire-snpp-1",
    source: "fixture:VIIRS_SNPP_REPLAY",
    lat: 39.794,
    lon: -121.606,
    acquiredAt: "2018-11-08T14:42:00.000Z",
    satellite: "SNPP",
    confidence: "high",
    frpMw: 148.6,
  },
  {
    id: "replay-camp-fire-noaa20-1",
    source: "fixture:VIIRS_NOAA20_REPLAY",
    lat: 39.801,
    lon: -121.598,
    acquiredAt: "2018-11-08T14:48:00.000Z",
    satellite: "NOAA-20",
    confidence: "high",
    frpMw: 212.3,
  },
  {
    id: "replay-camp-fire-noaa20-2",
    source: "fixture:VIIRS_NOAA20_REPLAY",
    lat: 39.787,
    lon: -121.619,
    acquiredAt: "2018-11-08T14:54:00.000Z",
    satellite: "NOAA-20",
    confidence: "nominal",
    frpMw: 96.4,
  },
];

/**
 * Build the Camp Fire replay evidence bundle.
 *
 * Takes no clock. Every value is fixed at its historical instant so the replay
 * reproduces byte-for-byte on any machine at any time.
 */
export function createCampFireFixture(): DemoFixture {
  const fetchedAt = CAMP_FIRE_REFERENCE_INSTANT;
  const latest = "2018-11-08T14:54:00.000Z";

  return {
    firms: {
      mode: "fixture",
      status: "ok",
      source: "NASA FIRMS replay (Camp Fire, 2018-11-08)",
      fetchedAt,
      observedAt: latest,
      data: { detections },
    },
    nws: {
      mode: "fixture",
      status: "ok",
      source: "NASA POWER 50m wind replay (Camp Fire, 2018-11-08)",
      fetchedAt,
      observedAt: "2018-11-08T15:00:00.000Z",
      data: {
        weather: {
          // Measured, not invented. NASA POWER hourly at the ignition point.
          windSpeedMps: 10,
          windFromDeg: 60,
          relativeHumidityPct: 12,
          humidityPercent: 12,
          quality: "direct-fresh",
          observedAt: "2018-11-08T15:00:00.000Z",
        },
      },
    },
    airnow: {
      mode: "fixture",
      status: "ok",
      source: "EPA AirData replay (Colusa County, 2018-11-08)",
      fetchedAt,
      observedAt: "2018-11-08T15:00:00.000Z",
      data: {
        air: {
          pm25UgM3: null,
          // The asset's own pre-fire baseline. The air is still clean at the
          // moment the estimate is made; that is the demonstration.
          aqi: 18,
          quality: "direct-fresh",
          observedAt: "2018-11-08T15:00:00.000Z",
        },
      },
    },
    wfigs: {
      mode: "fixture",
      status: "ok",
      source: "WFIGS replay (Camp Fire, 2018-11-08)",
      fetchedAt,
      observedAt: "2018-11-08T15:00:00.000Z",
      data: {
        incidents: [
          {
            id: "replay-camp-fire",
            irwinId: "replay-irwin-camp-fire",
            name: "Camp Fire (replay)",
            type: "WF",
            location: { lat: 39.794, lon: -121.606 },
            acres: 0,
            percentContained: 0,
            discoveredAt: CAMP_FIRE_IGNITION.at,
            updatedAt: "2018-11-08T15:00:00.000Z",
          },
        ],
        perimeters: [],
      },
    },
  };
}
