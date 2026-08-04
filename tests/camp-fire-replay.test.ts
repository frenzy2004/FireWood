import { describe, expect, it } from "vitest";

import { estimateSmokeArrival } from "../lib/domain/smoke";
import {
  CAMP_FIRE_ASSET,
  CAMP_FIRE_BBOX,
  CAMP_FIRE_IGNITION,
  CAMP_FIRE_OBSERVED_ARRIVAL_HOURS,
  CAMP_FIRE_REFERENCE_INSTANT,
} from "../lib/fixtures/camp-fire";
import { getVirtualAsset } from "../lib/fixtures/registry";
import { buildSnapshot } from "../lib/server/snapshot";

/**
 * End-to-end replay of the 2018 Camp Fire.
 *
 * This is the claim the whole feature rests on: from a satellite detection and
 * the wind measured beside it, EmberField estimates smoke arrival at a farm
 * 104 km downwind hours before the smoke lands — and the estimate can be
 * checked against what the EPA monitor at that location actually recorded.
 */
const replaySnapshot = () =>
  buildSnapshot({
    asset: CAMP_FIRE_ASSET,
    bbox: CAMP_FIRE_BBOX,
    mode: "fixture",
  });

describe("Camp Fire replay", () => {
  it("is registered as a virtual asset with a pinned reference instant", () => {
    const entry = getVirtualAsset(CAMP_FIRE_ASSET.id);
    expect(entry).not.toBeNull();
    expect(entry?.referenceInstant).toBe(CAMP_FIRE_REFERENCE_INSTANT);
  });

  it("evaluates at the historical instant rather than the wall clock", async () => {
    const snapshot = await replaySnapshot();
    expect(snapshot.mode).toBe("fixture");
    expect(snapshot.generatedAt).toBe(CAMP_FIRE_REFERENCE_INSTANT);
  });

  it("groups the ignition detections into a single source", async () => {
    const snapshot = await replaySnapshot();
    expect(snapshot.detections).toHaveLength(3);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].cluster.satellites.sort()).toEqual([
      "NOAA-20",
      "SNPP",
    ]);
  });

  it("shows clean air at the asset while smoke is already inbound", async () => {
    const snapshot = await replaySnapshot();
    // The demonstration: nothing is wrong yet at the farm.
    expect(snapshot.air?.aqi).toBe(18);

    const group = snapshot.groups[0];
    const arrival = estimateSmokeArrival({
      asset: CAMP_FIRE_ASSET.location,
      source: group.cluster.centroid,
      detectedAt: group.cluster.latestAcquiredAt,
      windFromDeg: group.weather?.windFromDeg ?? null,
      windSpeedMps: group.weather?.windSpeedMps ?? null,
      now: new Date(CAMP_FIRE_REFERENCE_INSTANT),
    });

    expect(arrival.status).toBe("inbound");
    expect(arrival.hoursUntilArrival as number).toBeGreaterThan(0);
  });

  it("predicts arrival close to what the EPA monitor recorded", async () => {
    const snapshot = await replaySnapshot();
    const group = snapshot.groups[0];
    const arrival = estimateSmokeArrival({
      asset: CAMP_FIRE_ASSET.location,
      source: group.cluster.centroid,
      detectedAt: group.cluster.latestAcquiredAt,
      windFromDeg: group.weather?.windFromDeg ?? null,
      windSpeedMps: group.weather?.windSpeedMps ?? null,
      now: new Date(CAMP_FIRE_REFERENCE_INSTANT),
    });

    // Hours from ignition, so the estimate is comparable to the observation.
    const ignitionMs = Date.parse(CAMP_FIRE_IGNITION.at);
    const predictedFromIgnition =
      (Date.parse(arrival.estimatedArrivalAt as string) - ignitionMs) / 3_600_000;

    expect(
      Math.abs(predictedFromIgnition - CAMP_FIRE_OBSERVED_ARRIVAL_HOURS),
    ).toBeLessThan(3);
  });

  it("gives the operator usable lead time before the smoke lands", async () => {
    const snapshot = await replaySnapshot();
    const group = snapshot.groups[0];
    const arrival = estimateSmokeArrival({
      asset: CAMP_FIRE_ASSET.location,
      source: group.cluster.centroid,
      detectedAt: group.cluster.latestAcquiredAt,
      windFromDeg: group.weather?.windFromDeg ?? null,
      windSpeedMps: group.weather?.windSpeedMps ?? null,
      now: new Date(CAMP_FIRE_REFERENCE_INSTANT),
    });

    // The point of the tool: hours of warning, not minutes.
    expect(arrival.hoursUntilArrival as number).toBeGreaterThan(2);
  });

  it("never overstates confidence or claims to predict fire spread", async () => {
    const snapshot = await replaySnapshot();
    const group = snapshot.groups[0];
    const arrival = estimateSmokeArrival({
      asset: CAMP_FIRE_ASSET.location,
      source: group.cluster.centroid,
      detectedAt: group.cluster.latestAcquiredAt,
      windFromDeg: group.weather?.windFromDeg ?? null,
      windSpeedMps: group.weather?.windSpeedMps ?? null,
      now: new Date(CAMP_FIRE_REFERENCE_INSTANT),
    });

    expect(["low", "moderate"]).toContain(arrival.confidence);
    expect(arrival.basis).toContain("not a fire-spread prediction");
  });

  it("reproduces identically on repeated builds", async () => {
    const [first, second] = await Promise.all([
      replaySnapshot(),
      replaySnapshot(),
    ]);
    expect(first.generatedAt).toBe(second.generatedAt);
    expect(first.groups[0].cluster.centroid).toEqual(
      second.groups[0].cluster.centroid,
    );
  });

  it("marks every source as replay data, never live", async () => {
    const snapshot = await replaySnapshot();
    for (const state of Object.values(snapshot.sources)) {
      expect(state.mode).toBe("fixture");
      expect(state.source).toContain("replay");
    }
    for (const detection of snapshot.detections) {
      expect(detection.source).toContain("REPLAY");
    }
  });
});
