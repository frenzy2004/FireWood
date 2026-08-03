import { describe, expect, it } from "vitest";

import { assessCluster } from "../lib/domain/score";
import type { AssessmentInput } from "../lib/domain/types";

const recentDownwindInput: AssessmentInput = {
  assetId: "asset-1",
  clusterId: "cluster-1",
  distanceKm: 3,
  ageHours: 2,
  confidence: "high",
  frpMw: 100,
  distinctPasses24h: 4,
  bearingClusterToAsset: 180,
  weather: {
    windFromDeg: 0,
    windSpeedMps: 10,
    relativeHumidityPct: 20,
    quality: "direct-fresh",
  },
  air: {
    pm25UgM3: 70,
    aqi: 200,
    quality: "direct-fresh",
  },
};

describe("assessCluster", () => {
  it("scores a current downwind cluster and exposes every contribution", () => {
    const result = assessCluster(recentDownwindInput);

    expect(result.score).toBeGreaterThan(60);
    expect(result.score).toBe(87);
    expect(result.reasons.map(({ code }) => code)).toContain("downwind");
    expect(result.contributions).toHaveLength(9);
    expect(result.completeness).toBe("complete");
    expect(result.dataConfidence).toBe(100);
    expect(result.scoreRange).toEqual({ low: result.score, high: result.score });
  });

  it("reports grouped missing inputs and a bounded uncertainty range", () => {
    const limited = assessCluster({
      ...recentDownwindInput,
      weather: null,
      air: null,
    });

    expect(limited.missingInputs).toEqual(["weather", "air-quality"]);
    expect(limited.dataQuality).toBe("limited");
    expect(limited.scoreRange?.low).toBe(limited.score);
    expect(limited.scoreRange?.high).toBeGreaterThan(limited.score ?? 0);
  });

  it("gates strong secondary conditions when detections are distant and stale", () => {
    const near = assessCluster(recentDownwindInput);
    const distant = assessCluster({
      ...recentDownwindInput,
      distanceKm: 30,
      ageHours: 30,
    });

    expect(near.score).toBe(87);
    expect(distant.score).toBe(21);
    expect((near.score ?? 0) - (distant.score ?? 0)).toBeGreaterThan(60);
  });

  it("prefers PM2.5 over AQI and applies source quality", () => {
    const result = assessCluster({
      ...recentDownwindInput,
      air: {
        pm25UgM3: 20,
        aqi: 200,
        quality: "derived-or-stale",
      },
    });
    const air = result.contributions.find(({ code }) => code === "air-quality");

    expect(air?.normalizedValue).toBe(0.2);
    expect(air?.quality).toBe(0.7);
    expect(air?.weightedValue).toBeCloseTo(0.0098, 4);
    expect(result.dataConfidence).toBe(98);
  });

  it("does not score absent mandatory proximity or recency", () => {
    const result = assessCluster({ ...recentDownwindInput, distanceKm: null });

    expect(result.score).toBeNull();
    expect(result.scoreRange).toBeNull();
    expect(result.canAutomateAlerts).toBe(false);
    expect(result.missingInputs).toContain("distance");
  });

  it("suppresses automated alerts below 60 data confidence", () => {
    const result = assessCluster({
      ...recentDownwindInput,
      confidence: null,
      frpMw: null,
      distinctPasses24h: null,
      bearingClusterToAsset: null,
      weather: null,
      air: null,
    });

    expect(result.dataConfidence).toBe(40);
    expect(result.canAutomateAlerts).toBe(false);
  });
});
