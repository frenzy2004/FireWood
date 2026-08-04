import { describe, expect, it } from "vitest";

import {
  triageAsset,
  triagePortfolio,
  type TriageAssetInput,
} from "../lib/domain/triage";

const GENERATED_AT = "2026-08-04T12:00:00.000Z";
const ACQUIRED_AT = "2026-08-04T11:30:00.000Z";

const asset = (id: string, name: string, lat: number, lon: number) => ({
  id,
  name,
  location: { lat, lon },
  radiusKm: 60,
});

/** Wind blowing from the east carries smoke due west. */
const westerlyTransport = { windFromDeg: 90, windSpeedMps: 8, relativeHumidityPct: 20, quality: "direct-fresh" as const };

const group = (
  lat: number,
  lon: number,
  overrides: Partial<TriageAssetInput["groups"][number]> = {},
) => ({
  centroid: { lat, lon },
  detectionCount: 12,
  latestAcquiredAt: ACQUIRED_AT,
  weather: westerlyTransport,
  score: 40,
  band: "elevated-context",
  missingInputs: [],
  ...overrides,
});

const input = (
  id: string,
  name: string,
  lat: number,
  lon: number,
  groups: TriageAssetInput["groups"],
): TriageAssetInput => ({
  asset: asset(id, name, lat, lon),
  generatedAt: GENERATED_AT,
  detectionCount: groups.reduce((total, g) => total + g.detectionCount, 0),
  groups,
  air: null,
});

describe("triageAsset", () => {
  it("reports smoke inbound when a group is upwind", () => {
    // Source 0.4 degrees east of the asset, wind from the east.
    const row = triageAsset(input("a", "Orchard", 40, -120, [group(40, -119.6)]));
    expect(row.status).toBe("smoke-inbound");
    expect(row.hoursUntilArrival).toBeGreaterThan(0);
    expect(row.summary).toContain("has smoke inbound and arrives in");
  });

  it("reports activity nearby when nothing is upwind", () => {
    // Source west of the asset while the wind carries smoke further west.
    const row = triageAsset(input("a", "Barn", 40, -120, [group(40, -120.4)]));
    expect(row.status).toBe("activity-nearby");
    expect(row.hoursUntilArrival).toBeNull();
    expect(row.summary).toContain("none upwind");
  });

  it("reports clear when no detections are in range", () => {
    const row = triageAsset(input("a", "Storage", 40, -120, []));
    expect(row.status).toBe("clear");
    expect(row.nearestGroupKm).toBeNull();
    // Never claims safety from an empty result.
    expect(row.summary).toContain("does not establish absence of fire");
  });

  it("does not call an asset clear when the detection feed never answered", () => {
    // Without a FIRMS key the feed returns nothing. Reporting that as "clear"
    // would have the console assert safety it never checked.
    const row = triageAsset({
      ...input("a", "Storage", 40, -120, []),
      detectionsAvailable: false,
    });
    expect(row.status).toBe("not-assessable");
    expect(row.missingData).toContain("detection-feed");
    expect(row.summary).not.toContain("no recent satellite detections");
  });

  it("still reports clear when the feed answered and found nothing", () => {
    const row = triageAsset({
      ...input("a", "Storage", 40, -120, []),
      detectionsAvailable: true,
    });
    expect(row.status).toBe("clear");
  });

  it("names missing transport inputs rather than assuming clear", () => {
    const row = triageAsset(
      input("a", "Pasture", 40, -120, [group(40, -119.6, { weather: null })]),
    );
    expect(row.status).toBe("not-assessable");
    expect(row.missingData).toEqual(["wind-speed", "wind-direction"]);
    expect(row.summary).toContain("Missing:");
  });

  it("takes the soonest inbound group, not an average", () => {
    const row = triageAsset(
      input("a", "Crew", 40, -120, [
        group(40, -119.9), // closer, arrives sooner
        group(40, -119.6),
      ]),
    );
    const near = triageAsset(input("a", "Crew", 40, -120, [group(40, -119.9)]));
    expect(row.hoursUntilArrival).toBe(near.hoursUntilArrival);
  });

  it("reports the nearest group regardless of wind direction", () => {
    const row = triageAsset(
      input("a", "Barn", 40, -120, [
        group(40, -119.6), // upwind, further
        group(40, -120.1), // downwind, nearer
      ]),
    );
    expect(row.status).toBe("smoke-inbound");
    // Proximity is independent of the arrival estimate.
    expect(row.nearestGroupKm).toBeLessThan(10);
  });
});

describe("triagePortfolio", () => {
  const portfolio = () =>
    triagePortfolio([
      input("clear", "Storage shed", 40, -120, []),
      input("far", "North orchard", 40, -120, [group(40, -119.7)]),
      input("near", "Crew site", 40, -120, [group(40, -119.9)]),
      input("off", "Hay barn", 40, -120, [group(40, -120.4)]),
    ]);

  it("puts the soonest inbound asset first", () => {
    const result = portfolio();
    expect(result.assets[0].assetId).toBe("near");
    expect(result.assets[0].status).toBe("smoke-inbound");
  });

  it("orders inbound before nearby before clear", () => {
    const statuses = portfolio().assets.map((row) => row.status);
    expect(statuses).toEqual([
      "smoke-inbound",
      "smoke-inbound",
      "activity-nearby",
      "clear",
    ]);
  });

  it("breaks ties inside a status on imminence", () => {
    const [first, second] = portfolio().assets;
    expect(first.hoursUntilArrival as number).toBeLessThan(
      second.hoursUntilArrival as number,
    );
  });

  it("summarises the portfolio with the soonest asset named", () => {
    const result = portfolio();
    expect(result.assetsScanned).toBe(4);
    expect(result.assetsInbound).toBe(2);
    expect(result.summary).toContain("2 assets of 4 scanned have smoke inbound");
    expect(result.summary).toContain("Crew site is soonest");
  });

  it("says so plainly when nothing is inbound, without implying safety", () => {
    const result = triagePortfolio([
      input("a", "Storage shed", 40, -120, []),
      input("b", "Hay barn", 40, -120, [group(40, -120.4)]),
    ]);
    expect(result.assetsInbound).toBe(0);
    expect(result.summary).toContain("No saved asset has smoke inbound");
    expect(result.summary).toContain("Wind shifts invalidate this immediately");
  });

  it("does not imply safety when nothing could be assessed", () => {
    const result = triagePortfolio([
      { ...input("a", "Storage shed", 40, -120, []), detectionsAvailable: false },
      { ...input("b", "Hay barn", 40, -120, []), detectionsAvailable: false },
    ]);
    expect(result.assetsInbound).toBe(0);
    expect(result.summary).toContain("No asset could be assessed");
    expect(result.summary).not.toContain("No saved asset has smoke inbound");
  });

  it("handles an empty portfolio", () => {
    const result = triagePortfolio([]);
    expect(result.assets).toEqual([]);
    expect(result.summary).toBe("No saved assets were scanned.");
  });
});
