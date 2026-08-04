import { describe, expect, it } from "vitest";

import {
  ADVECTION_BIAS_HOURS,
  MAX_VALIDATED_RANGE_KM,
  PLUME_HALF_WIDTH_DEG,
  estimateSmokeArrival,
} from "../lib/domain/smoke";

// Camp Fire ignition point and time. 06:30 PST on 8 November 2018.
const CAMP_FIRE = { lat: 39.794, lon: -121.606 };
const IGNITION = "2018-11-08T14:30:00.000Z";

// NASA POWER hourly, 50 m wind averaged over 14:00-24:00 UTC at the ignition
// point: 10.0 m/s from 060 deg, so transport ran toward 240 deg.
const CAMP_FIRE_WIND = { windFromDeg: 60, windSpeedMps: 10 };

/**
 * Ground truth from EPA AirData hourly PM2.5 (parameter 88101, 2018).
 *
 * Observed arrival is the first hour each monitor exceeded three times its own
 * 5-7 November median, measured in hours from ignition. Every California
 * monitor within 300 km and 50 degrees of the transport bearing is included —
 * the two that the model gets badly wrong are kept deliberately, because a
 * validation fixture that quietly drops its failures is not a validation.
 */
const OBSERVED_ARRIVALS = [
  { county: "Colusa", lat: 39.021221, lon: -122.281803, observedHours: 6.5 },
  { county: "Mendocino", lat: 39.15047, lon: -123.20655, observedHours: 3.5 },
  // Outlier: model predicts ~9.8 h early. Coastal-range terrain channelling.
  { county: "Mendocino", lat: 39.41174, lon: -123.35264, observedHours: 15.5 },
  { county: "Napa", lat: 38.278849, lon: -122.275024, observedHours: 6.5 },
  { county: "Sonoma", lat: 38.403765, lon: -122.818294, observedHours: 5.5 },
  { county: "Contra Costa", lat: 37.936013, lon: -122.026154, observedHours: 6.5 },
  { county: "Contra Costa", lat: 37.9604, lon: -122.356811, observedHours: 7.5 },
  { county: "Marin", lat: 37.97231, lon: -122.520004, observedHours: 7.5 },
  { county: "Alameda", lat: 37.864767, lon: -122.302741, observedHours: 7.5 },
  { county: "Alameda", lat: 37.814781, lon: -122.282347, observedHours: 7.5 },
  { county: "Alameda", lat: 37.793624, lon: -122.263376, observedHours: 7.5 },
  { county: "Alameda", lat: 37.743065, lon: -122.169935, observedHours: 6.5 },
  { county: "San Francisco", lat: 37.765946, lon: -122.399044, observedHours: 8.5 },
  // Outlier: model predicts ~3.8 h early at the far edge of the cohort.
  { county: "San Mateo", lat: 37.482934, lon: -122.20337, observedHours: 12.5 },
] as const;

const arrivalFor = (asset: { lat: number; lon: number }) =>
  estimateSmokeArrival({
    asset,
    source: CAMP_FIRE,
    detectedAt: IGNITION,
    ...CAMP_FIRE_WIND,
    now: new Date(IGNITION),
  });

const signedErrors = () =>
  OBSERVED_ARRIVALS.map((monitor) => ({
    county: monitor.county,
    // Positive means the model said smoke would arrive later than it did.
    error: (arrivalFor(monitor).transitHours as number) - monitor.observedHours,
  }));

describe("estimateSmokeArrival — Camp Fire validation", () => {
  it("places every validation monitor inside the plume corridor", () => {
    for (const monitor of OBSERVED_ARRIVALS) {
      const arrival = arrivalFor(monitor);
      expect(arrival.status, `${monitor.county} should be inbound`).toBe(
        "inbound",
      );
      expect(arrival.offAxisDeg).toBeLessThanOrEqual(PLUME_HALF_WIDTH_DEG);
    }
  });

  it("keeps mean absolute error under two hours across all 14 monitors", () => {
    const errors = signedErrors();
    const meanAbsolute =
      errors.reduce((total, row) => total + Math.abs(row.error), 0) /
      errors.length;
    expect(errors).toHaveLength(14);
    expect(meanAbsolute).toBeLessThan(2);
  });

  it("centres the corrected estimate on observation", () => {
    const sorted = signedErrors()
      .map((row) => row.error)
      .sort((a, b) => a - b);
    const median = (sorted[6] + sorted[7]) / 2;
    // The bias correction is calibrated to remove systematic lateness.
    expect(Math.abs(median)).toBeLessThan(0.5);
  });

  it("never warns a monitor more than three hours late", () => {
    // Lateness is the safety-relevant direction: smoke arriving before the
    // estimate is worse than smoke arriving after it. Early estimates are
    // tolerated and are where both known outliers sit.
    for (const row of signedErrors()) {
      expect(row.error, `${row.county} was ${row.error.toFixed(1)} h late`)
        .toBeLessThan(3);
    }
  });

  it("derives the transport bearing from the reported wind origin", () => {
    // Wind from 060 deg carries smoke toward 240 deg.
    expect(arrivalFor(OBSERVED_ARRIVALS[0]).transportBearingDeg).toBe(240);
  });
});

describe("estimateSmokeArrival — gating", () => {
  const base = {
    asset: { lat: 38.3, lon: -122.5 },
    source: CAMP_FIRE,
    detectedAt: IGNITION,
    now: new Date(IGNITION),
  };

  it("reports missing inputs instead of assuming zero", () => {
    const arrival = estimateSmokeArrival({
      ...base,
      windFromDeg: null,
      windSpeedMps: null,
    });
    expect(arrival.status).toBe("insufficient-data");
    expect(arrival.confidence).toBe("none");
    expect(arrival.missingData).toEqual(["wind-speed", "wind-direction"]);
    expect(arrival.estimatedArrivalAt).toBeNull();
  });

  it("refuses a transport direction in calm wind", () => {
    const arrival = estimateSmokeArrival({
      ...base,
      windFromDeg: 60,
      windSpeedMps: 0.4,
    });
    expect(arrival.status).toBe("calm-wind");
    expect(arrival.estimatedArrivalAt).toBeNull();
  });

  it("excludes assets outside the plume corridor", () => {
    // Wind from 240 deg pushes smoke northeast, away from a southwest asset.
    const arrival = estimateSmokeArrival({
      ...base,
      windFromDeg: 240,
      windSpeedMps: 10,
    });
    expect(arrival.status).toBe("off-plume");
    expect(arrival.offAxisDeg).toBeGreaterThan(PLUME_HALF_WIDTH_DEG);
    expect(arrival.estimatedArrivalAt).toBeNull();
  });

  it("flags estimates beyond the validated range and caps confidence", () => {
    const arrival = estimateSmokeArrival({
      ...base,
      asset: { lat: 36.6, lon: -123.9 },
      windFromDeg: 60,
      windSpeedMps: 10,
    });
    expect(arrival.distanceKm).toBeGreaterThan(MAX_VALIDATED_RANGE_KM);
    expect(arrival.status).toBe("beyond-range");
    expect(arrival.confidence).toBe("low");
    expect(arrival.basis).toContain("validated envelope");
  });

  it("never claims more than moderate confidence", () => {
    for (const monitor of OBSERVED_ARRIVALS) {
      expect(["none", "low", "moderate"]).toContain(
        arrivalFor(monitor).confidence,
      );
    }
  });

  it("marks an estimate that has already elapsed as arrived", () => {
    const arrival = estimateSmokeArrival({
      ...base,
      ...CAMP_FIRE_WIND,
      now: new Date("2018-11-09T06:00:00.000Z"),
    });
    expect(arrival.status).toBe("likely-arrived");
    expect(arrival.hoursUntilArrival as number).toBeLessThan(0);
  });

  it("applies the documented lateness correction", () => {
    const arrival = estimateSmokeArrival({ ...base, ...CAMP_FIRE_WIND });
    expect(
      (arrival.transitHours as number) - (arrival.rawTransitHours as number),
    ).toBeCloseTo(ADVECTION_BIAS_HOURS, 5);
  });

  it("states that it is not a fire-spread prediction", () => {
    const arrival = estimateSmokeArrival({ ...base, ...CAMP_FIRE_WIND });
    expect(arrival.basis).toContain("not a fire-spread prediction");
  });
});
