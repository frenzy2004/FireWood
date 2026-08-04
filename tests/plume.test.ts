import { describe, expect, it } from "vitest";

import { bearingDegrees, distanceKm } from "../lib/domain/geometry";
import {
  MAX_ISOCHRONE_HOURS,
  corridorFeature,
  destinationPoint,
  isochroneFeatures,
} from "../lib/domain/plume";
import { PLUME_HALF_WIDTH_DEG } from "../lib/domain/smoke";

const ORIGIN = { lat: 39.794, lon: -121.606 };
const TRANSPORT_BEARING = 240;

const asCoordinate = ([lon, lat]: [number, number]) => ({ lat, lon });

describe("destinationPoint", () => {
  it("returns the origin for zero distance", () => {
    const [lon, lat] = destinationPoint(ORIGIN, 240, 0);
    expect(lat).toBeCloseTo(ORIGIN.lat, 9);
    expect(lon).toBeCloseTo(ORIGIN.lon, 9);
  });

  it("lands the requested distance away", () => {
    const point = asCoordinate(destinationPoint(ORIGIN, TRANSPORT_BEARING, 103.6));
    expect(distanceKm(ORIGIN, point)).toBeCloseTo(103.6, 3);
  });

  it("lands on the requested bearing", () => {
    const point = asCoordinate(destinationPoint(ORIGIN, TRANSPORT_BEARING, 103.6));
    expect(bearingDegrees(ORIGIN, point)).toBeCloseTo(TRANSPORT_BEARING, 1);
  });

  it("moves north for bearing zero and south for bearing 180", () => {
    expect(destinationPoint(ORIGIN, 0, 50)[1]).toBeGreaterThan(ORIGIN.lat);
    expect(destinationPoint(ORIGIN, 180, 50)[1]).toBeLessThan(ORIGIN.lat);
  });
});

describe("corridorFeature", () => {
  const corridor = corridorFeature(ORIGIN, TRANSPORT_BEARING, PLUME_HALF_WIDTH_DEG, 130);
  const ring = corridor.geometry.coordinates[0];

  it("produces a closed ring anchored at the detection centroid", () => {
    expect(ring[0]).toEqual([ORIGIN.lon, ORIGIN.lat]);
    expect(ring.at(-1)).toEqual(ring[0]);
  });

  it("opens exactly the configured half-width either side of transport", () => {
    // ring[1] is the first arc point, ring.at(-2) the last.
    const leading = bearingDegrees(ORIGIN, asCoordinate(ring[1]));
    const trailing = bearingDegrees(ORIGIN, asCoordinate(ring.at(-2) as [number, number]));
    expect(leading).toBeCloseTo(TRANSPORT_BEARING - PLUME_HALF_WIDTH_DEG, 1);
    expect(trailing).toBeCloseTo(TRANSPORT_BEARING + PLUME_HALF_WIDTH_DEG, 1);
  });

  it("keeps every arc point at the corridor range", () => {
    for (const point of ring.slice(1, -1)) {
      expect(distanceKm(ORIGIN, asCoordinate(point))).toBeCloseTo(130, 3);
    }
  });

  it("contains an asset that sits inside the corridor", () => {
    // The Colusa asset: 103.6 km out, 26 degrees off the transport bearing.
    const asset = asCoordinate(destinationPoint(ORIGIN, TRANSPORT_BEARING - 26, 103.6));
    const offAxis = Math.abs(bearingDegrees(ORIGIN, asset) - TRANSPORT_BEARING);
    expect(offAxis).toBeLessThan(PLUME_HALF_WIDTH_DEG);
    expect(distanceKm(ORIGIN, asset)).toBeLessThan(130);
  });
});

describe("isochroneFeatures", () => {
  // 10 m/s == 36 km/h, so hour N sits at 36N km.
  const isochrones = isochroneFeatures(ORIGIN, TRANSPORT_BEARING, PLUME_HALF_WIDTH_DEG, 10, 130);

  it("places each arc at wind speed times elapsed hours", () => {
    for (const feature of isochrones.features) {
      const expected = 36 * feature.properties.hour;
      expect(feature.properties.distanceKm).toBeCloseTo(expected, 6);
      for (const point of feature.geometry.coordinates) {
        expect(distanceKm(ORIGIN, asCoordinate(point))).toBeCloseTo(expected, 3);
      }
    }
  });

  it("stops at the corridor range rather than clamping to it", () => {
    // 36, 72, 108 fit inside 130; 144 does not.
    expect(isochrones.features.map((f) => f.properties.hour)).toEqual([1, 2, 3]);
    for (const feature of isochrones.features) {
      expect(feature.properties.distanceKm).toBeLessThanOrEqual(130);
    }
  });

  it("emits hours in increasing order", () => {
    const hours = isochrones.features.map((f) => f.properties.hour);
    expect([...hours].sort((a, b) => a - b)).toEqual(hours);
  });

  it("never exceeds the drawable horizon", () => {
    const far = isochroneFeatures(ORIGIN, TRANSPORT_BEARING, PLUME_HALF_WIDTH_DEG, 40, 100_000);
    expect(far.features.length).toBe(MAX_ISOCHRONE_HOURS);
  });

  it("returns nothing when there is no wind to carry the plume", () => {
    expect(isochroneFeatures(ORIGIN, TRANSPORT_BEARING, PLUME_HALF_WIDTH_DEG, 0, 130).features).toEqual([]);
  });

  it("spans the same corridor width as the wedge", () => {
    const first = isochrones.features[0].geometry.coordinates;
    expect(bearingDegrees(ORIGIN, asCoordinate(first[0])))
      .toBeCloseTo(TRANSPORT_BEARING - PLUME_HALF_WIDTH_DEG, 1);
    expect(bearingDegrees(ORIGIN, asCoordinate(first.at(-1) as [number, number])))
      .toBeCloseTo(TRANSPORT_BEARING + PLUME_HALF_WIDTH_DEG, 1);
  });
});
