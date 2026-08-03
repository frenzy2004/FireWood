import { describe, expect, it } from "vitest";

import {
  angleDifference,
  bearingDegrees,
  boundingBox,
  distanceKm,
} from "../lib/domain/geometry";

describe("distanceKm", () => {
  it("uses Haversine distance in kilometres", () => {
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(
      111.195,
      2,
    );
  });
});

describe("bearingDegrees", () => {
  it("returns a normalized initial bearing", () => {
    expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 1, lon: 1 })).toBeCloseTo(
      44.996,
      2,
    );
  });
});

describe("angleDifference", () => {
  it("uses the shortest path across north", () => {
    expect(angleDifference(350, 10)).toBe(20);
  });
});

describe("boundingBox", () => {
  it("extends west and east of the center", () => {
    const box = boundingBox({ lat: 36.7783, lon: -119.4179 }, 16);

    expect(box.west).toBeLessThan(-119.4179);
    expect(box.east).toBeGreaterThan(-119.4179);
  });

  it("marks a box that crosses the antimeridian", () => {
    const box = boundingBox({ lat: 0, lon: 179.9 }, 50);

    expect(box.crossesAntimeridian).toBe(true);
    expect(box.west).toBeGreaterThan(box.east);
  });

  it("clamps latitude at the poles", () => {
    const box = boundingBox({ lat: 89.99, lon: 0 }, 50);

    expect(box.north).toBe(90);
    expect(box.south).toBeGreaterThanOrEqual(-90);
  });
});
