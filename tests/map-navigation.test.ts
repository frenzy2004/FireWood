import { describe, expect, it } from "vitest";

import {
  buildMapFocusPlan,
  groupForDetection,
  selectionLocation,
} from "../app/components/map-navigation";
import type { DashboardSnapshot } from "../app/hooks/use-dashboard";

const detection = {
  id: "detection-1",
  lat: 11,
  lon: 22,
  acquiredAt: "2026-08-04T14:48:00.000Z",
  satellite: "NOAA-20",
  confidence: "high",
  frpMw: 42.5,
};

const snapshot = {
  mode: "live",
  generatedAt: "2026-08-04T15:00:00.000Z",
  asset: {
    id: "orchard-1",
    name: "Colusa Orchard",
    location: { lat: 10, lon: 20 },
    radiusKm: 111.32,
  },
  detections: [detection],
  groups: [{
    cluster: {
      id: "group-1",
      centroid: { lat: 12, lon: 21 },
      detections: [detection],
      memberFingerprints: [detection.id],
      detectionCount: 1,
      firstAcquiredAt: detection.acquiredAt,
      latestAcquiredAt: detection.acquiredAt,
      satellites: [detection.satellite],
      maxConfidence: detection.confidence,
      maxFrpMw: detection.frpMw,
    },
    weather: null,
    assessment: {
      score: null,
      scoreRange: null,
      band: "unassessed",
      contributions: [],
      reasons: [],
      missingInputs: [],
      completeness: "partial",
      dataQuality: "limited",
      dataConfidence: 0,
    },
    officialMatch: null,
  }],
  incidents: [{
    id: "incident-1",
    name: "CHUTE",
    location: { lat: 8, lon: 18 },
  }],
  perimeters: [{
    id: "perimeter-1",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [[
          [17, 7],
          [23, 13],
          [17, 7],
        ]],
        [[["bad", 9], [Number.POSITIVE_INFINITY, 12]]],
      ],
    },
  }],
  air: null,
  sources: {},
} as unknown as DashboardSnapshot;

describe("grounded map navigation", () => {
  it("frames the asset radius using geographic latitude and longitude deltas", () => {
    const plan = buildMapFocusPlan(snapshot, "asset");

    expect(plan.mode).toBe("asset");
    expect(plan.bounds[0][0]).toBeCloseTo(18.9846, 4);
    expect(plan.bounds[0][1]).toBeCloseTo(9, 6);
    expect(plan.bounds[1][0]).toBeCloseTo(21.0154, 4);
    expect(plan.bounds[1][1]).toBeCloseTo(11, 6);
    expect(plan.target).toEqual({ lat: 10, lon: 20 });
  });

  it("frames all visible evidence and ignores malformed perimeter coordinates", () => {
    expect(buildMapFocusPlan(snapshot, "evidence")).toEqual({
      mode: "evidence",
      bounds: [[17, 7], [23, 13]],
      target: { lat: 10, lon: 20 },
    });
  });

  it("frames the selected threat together with the asset", () => {
    expect(buildMapFocusPlan(snapshot, "threat", "group-1")).toEqual({
      mode: "threat",
      bounds: [[20, 10], [21, 12]],
      target: { lat: 12, lon: 21 },
    });
  });

  it("falls back to an expanded asset frame when threat evidence is absent", () => {
    const emptySnapshot = {
      ...snapshot,
      asset: { ...snapshot.asset, location: { lat: 0, lon: 0 }, radiusKm: 0 },
      detections: [],
      groups: [],
      incidents: [],
      perimeters: [],
    } as DashboardSnapshot;

    expect(buildMapFocusPlan(emptySnapshot, "threat")).toEqual({
      mode: "asset",
      bounds: [[-0.01, -0.01], [0.01, 0.01]],
      target: { lat: 0, lon: 0 },
    });
    expect(buildMapFocusPlan(emptySnapshot, "evidence").bounds).toEqual([
      [-0.01, -0.01],
      [0.01, 0.01],
    ]);
  });

  it("resolves selection coordinates without depending on MapLibre", () => {
    expect(selectionLocation(snapshot, { kind: "detection", id: "detection-1" })).toEqual({ lat: 11, lon: 22 });
    expect(selectionLocation(snapshot, { kind: "group", id: "group-1" })).toEqual({ lat: 12, lon: 21 });
    expect(selectionLocation(snapshot, { kind: "incident", id: "incident-1" })).toEqual({ lat: 8, lon: 18 });
    expect(selectionLocation(snapshot, { kind: "incident", id: "missing" })).toBeNull();
  });

  it("maps a real detection id to its activity group", () => {
    expect(groupForDetection(snapshot, "detection-1")?.cluster.id).toBe("group-1");
    expect(groupForDetection(snapshot, "missing")).toBeUndefined();
  });
});
