import { describe, expect, it } from "vitest";

import { clusterDetections } from "../lib/domain/cluster";
import type { Detection } from "../lib/domain/types";

const rows: Detection[] = [
  {
    lat: 36,
    lon: -120,
    acquiredAt: "2026-08-03T00:00:00.000Z",
    satellite: "NOAA-20",
    confidence: "nominal",
    frpMw: 12,
  },
  {
    lat: 36.005,
    lon: -120,
    acquiredAt: "2026-08-03T02:00:00.000Z",
    satellite: "NOAA-21",
    confidence: "high",
    frpMw: 35,
  },
  {
    lat: 36.01,
    lon: -120,
    acquiredAt: "2026-08-03T07:00:00.000Z",
    satellite: "NOAA-20",
    confidence: "low",
    frpMw: 8,
  },
  {
    lat: 37,
    lon: -121,
    acquiredAt: "2026-08-03T03:00:00.000Z",
    satellite: "GOES-18",
    confidence: "low",
    frpMw: null,
  },
];

describe("clusterDetections", () => {
  it("builds connected components using distance and time thresholds", () => {
    const clusters = clusterDetections(rows, {
      maxDistanceKm: 1.5,
      maxGapHours: 6,
    });

    expect(clusters).toHaveLength(2);
    expect(clusters[0].satellites).toEqual(["NOAA-20", "NOAA-21"]);
    expect(clusters[0].detectionCount).toBe(3);
    expect(clusters[0].maxConfidence).toBe("high");
    expect(clusters[0].maxFrpMw).toBe(35);
    expect(clusters[0].firstAcquiredAt).toBe("2026-08-03T00:00:00.000Z");
    expect(clusters[0].latestAcquiredAt).toBe("2026-08-03T07:00:00.000Z");
    expect(clusters[0].centroid.lat).toBeCloseTo(36.005, 5);
  });

  it("uses transitive membership rather than comparing only to a centroid", () => {
    const transitive = rows.slice(0, 3).map((row, index) => ({
      ...row,
      lat: index * 0.01,
      lon: 0,
      acquiredAt: `2026-08-03T0${index}:00:00.000Z`,
    }));

    expect(
      clusterDetections(transitive, {
        maxDistanceKm: 1.5,
        maxGapHours: 6,
      }),
    ).toHaveLength(1);
  });

  it("returns the same cluster IDs and member order for shuffled input", () => {
    const options = { maxDistanceKm: 1.5, maxGapHours: 6 };
    const forward = clusterDetections(rows, options);
    const reverse = clusterDetections([...rows].reverse(), options);

    expect(reverse).toEqual(forward);
  });
});
