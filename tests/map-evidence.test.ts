import { describe, expect, it } from "vitest";

import {
  describeMapSelection,
  detectionSelectionId,
  type MapSelection,
} from "../app/components/map-evidence";
import type { DashboardSnapshot } from "../app/hooks/use-dashboard";

const detection = {
  id: "detection-1",
  source: "VIIRS_NOAA20_NRT",
  lat: 39.35,
  lon: -121.15,
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
    location: { lat: 39.021221, lon: -122.281803 },
    radiusKm: 120,
  },
  assetWeather: null,
  detections: [detection],
  groups: [{
    cluster: {
      id: "group-1",
      centroid: { lat: detection.lat, lon: detection.lon },
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
      score: 34,
      scoreRange: { low: 28, high: 40 },
      band: "watch",
      contributions: [],
      reasons: [],
      missingInputs: ["weather"],
      completeness: "partial",
      dataQuality: "limited",
      dataConfidence: 48,
    },
    officialMatch: null,
  }],
  incidents: [{
    id: "incident-1",
    name: "CHUTE",
    type: "WF",
    location: { lat: 39.351549, lon: -121.15071 },
    acres: 162,
    percentContained: 95,
    updatedAt: "2026-07-31T00:38:31.750Z",
  }],
  perimeters: [],
  air: null,
  sources: {
    firms: { mode: "live", status: "ok", source: "NASA FIRMS", sourceUrl: null, fetchedAt: "2026-08-04T15:00:00.000Z", observedAt: detection.acquiredAt },
    nws: { mode: "live", status: "ok", source: "NWS", sourceUrl: null, fetchedAt: "2026-08-04T15:00:00.000Z", observedAt: null },
    airnow: { mode: "live", status: "ok", source: "AirNow", sourceUrl: null, fetchedAt: "2026-08-04T15:00:00.000Z", observedAt: null },
    wfigs: { mode: "live", status: "ok", source: "WFIGS", sourceUrl: null, fetchedAt: "2026-08-04T15:00:00.000Z", observedAt: "2026-08-04T14:00:00.000Z" },
  },
} as unknown as DashboardSnapshot;

describe("map evidence selection", () => {
  it("describes an official incident without requiring a FIRMS group", () => {
    const withoutGroups = { ...snapshot, detections: [], groups: [] };

    expect(describeMapSelection(withoutGroups, { kind: "incident", id: "incident-1" }))
      .toMatchObject({
        kind: "incident",
        id: "incident-1",
        title: "CHUTE",
        source: "WFIGS",
        type: "WF",
        acres: 162,
        percentContained: 95,
        updatedAt: "2026-07-31T00:38:31.750Z",
        location: { lat: 39.351549, lon: -121.15071 },
    });
    expect(describeMapSelection(withoutGroups, { kind: "incident", id: "incident-1" })?.distanceKm)
      .toBeCloseTo(104.2, 1);
  });

  it("describes a raw detection with its exact source evidence", () => {
    expect(describeMapSelection(snapshot, { kind: "detection", id: "detection-1" }))
      .toMatchObject({
        kind: "detection",
        id: "detection-1",
        title: "NOAA-20 detection",
        source: "VIIRS_NOAA20_NRT",
        acquiredAt: "2026-08-04T14:48:00.000Z",
        confidence: "high",
        frpMw: 42.5,
      });
  });

  it("describes a detection group independently of the inspector component", () => {
    expect(describeMapSelection(snapshot, { kind: "group", id: "group-1" }))
      .toMatchObject({
        kind: "group",
        id: "group-1",
        title: "Activity group",
        source: "NASA FIRMS",
        detectionCount: 1,
        latestAcquiredAt: "2026-08-04T14:48:00.000Z",
        satellites: ["NOAA-20"],
      });
  });

  it("returns null for stale selections and gives anonymous detections a stable id", () => {
    const stale: MapSelection = { kind: "incident", id: "missing" };
    expect(describeMapSelection(snapshot, stale)).toBeNull();
    expect(detectionSelectionId({ ...detection, id: undefined }, 3)).toBe(
      "VIIRS_NOAA20_NRT|NOAA-20|2026-08-04T14:48:00.000Z|39.35|-121.15|3",
    );
  });
});
