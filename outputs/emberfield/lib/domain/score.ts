import { angleDifference } from "./geometry";
import type {
  Assessment,
  AssessmentBand,
  AssessmentContribution,
  AssessmentInput,
  DetectionConfidence,
  SourceQuality,
} from "./types";

type Knot = readonly [number, number];

const WEIGHTS = {
  distance: 0.25,
  age: 0.15,
  confidence: 0.1,
  frp: 0.1,
  passes: 0.1,
  downwind: 0.1,
  wind: 0.07,
  humidity: 0.06,
  air: 0.07,
} as const;

const distanceKnots: Knot[] = [
  [0, 1],
  [2, 1],
  [5, 0.8],
  [10, 0.55],
  [20, 0.25],
  [40, 0],
];
const ageKnots: Knot[] = [
  [0, 1],
  [3, 0.9],
  [6, 0.75],
  [12, 0.5],
  [24, 0.15],
  [36, 0],
];
const frpKnots: Knot[] = [
  [0, 0],
  [5, 0.2],
  [20, 0.45],
  [50, 0.7],
  [100, 0.9],
  [200, 1],
];
const passesKnots: Knot[] = [
  [1, 0],
  [2, 0.35],
  [3, 0.6],
  [4, 0.8],
  [6, 1],
];
const windKnots: Knot[] = [
  [0, 0],
  [2, 0.15],
  [5, 0.4],
  [10, 0.7],
  [15, 0.9],
  [20, 1],
];

const confidenceValues: Record<DetectionConfidence, number> = {
  low: 0.25,
  nominal: 0.6,
  high: 1,
};

const qualityValues: Record<SourceQuality, number> = {
  "direct-fresh": 1,
  "derived-or-stale": 0.7,
  "missing-or-expired": 0,
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const interpolate = (value: number, knots: Knot[]) => {
  if (value <= knots[0][0]) return knots[0][1];
  for (let index = 1; index < knots.length; index += 1) {
    const [rightX, rightY] = knots[index];
    const [leftX, leftY] = knots[index - 1];
    if (value <= rightX) {
      return leftY + ((value - leftX) / (rightX - leftX)) * (rightY - leftY);
    }
  }
  return knots[knots.length - 1][1];
};

const sourceQuality = (
  value: unknown,
  quality: SourceQuality | undefined,
) => (value === null || value === undefined ? 0 : qualityValues[quality ?? "direct-fresh"]);

const contribution = (
  code: string,
  label: string,
  weight: number,
  normalizedValue: number | null,
  quality: number,
): AssessmentContribution => ({
  code,
  label,
  weight,
  normalizedValue,
  quality,
  weightedValue: weight * (normalizedValue ?? 0) * quality,
  available: normalizedValue !== null && quality > 0,
});

const bandFor = (score: number | null): AssessmentBand => {
  if (score === null) return "unassessed";
  if (score < 25) return "low-context";
  if (score < 50) return "watch";
  if (score < 75) return "elevated-context";
  return "high-context";
};

export function assessCluster(input: AssessmentInput): Assessment {
  const weatherQuality = input.weather ? qualityValues[input.weather.quality] : 0;
  const airQuality = input.air ? qualityValues[input.air.quality] : 0;
  const distanceQuality = sourceQuality(
    input.distanceKm,
    input.sourceQuality?.distance,
  );
  const ageQuality = sourceQuality(input.ageHours, input.sourceQuality?.age);
  const confidenceQuality = sourceQuality(
    input.confidence,
    input.sourceQuality?.confidence,
  );
  const frpQuality = sourceQuality(input.frpMw, input.sourceQuality?.frp);
  const passesQuality = sourceQuality(
    input.distinctPasses24h,
    input.sourceQuality?.["distinct-passes"],
  );
  const bearingQuality = sourceQuality(
    input.bearingClusterToAsset,
    input.sourceQuality?.bearing,
  );
  const hasWindDirection = input.weather?.windFromDeg != null;
  const hasWindSpeed = input.weather?.windSpeedMps != null;
  const hasHumidity = input.weather?.relativeHumidityPct != null;
  const downwindQuality =
    hasWindDirection && hasWindSpeed
      ? Math.min(weatherQuality, bearingQuality)
      : 0;
  const windQuality = hasWindSpeed ? weatherQuality : 0;
  const humidityQuality = hasHumidity ? weatherQuality : 0;
  const airValue =
    input.air?.pm25UgM3 != null
      ? clamp01(input.air.pm25UgM3 / 100)
      : input.air?.aqi != null
        ? clamp01(input.air.aqi / 200)
        : null;
  const usableAirQuality = airValue === null ? 0 : airQuality;
  const downwindValue =
    downwindQuality === 0
      ? null
      : (input.weather?.windSpeedMps ?? 0) < 0.5
        ? 0
        : Math.max(
            0,
            Math.cos(
              (angleDifference(
                input.bearingClusterToAsset ?? 0,
                ((input.weather?.windFromDeg ?? 0) + 180) % 360,
              ) *
                Math.PI) /
                180,
            ),
          );

  const contributions: AssessmentContribution[] = [
    contribution(
      "distance",
      "Distance to asset",
      WEIGHTS.distance,
      input.distanceKm === null || !Number.isFinite(input.distanceKm)
        ? null
        : interpolate(input.distanceKm, distanceKnots),
      distanceQuality,
    ),
    contribution(
      "age",
      "Detection recency",
      WEIGHTS.age,
      input.ageHours === null || !Number.isFinite(input.ageHours)
        ? null
        : interpolate(input.ageHours, ageKnots),
      ageQuality,
    ),
    contribution(
      "confidence",
      "Detection confidence",
      WEIGHTS.confidence,
      input.confidence === null ? null : confidenceValues[input.confidence],
      confidenceQuality,
    ),
    contribution(
      "frp",
      "Fire radiative power",
      WEIGHTS.frp,
      input.frpMw === null || !Number.isFinite(input.frpMw)
        ? null
        : interpolate(input.frpMw, frpKnots),
      frpQuality,
    ),
    contribution(
      "distinct-passes",
      "Distinct satellite passes",
      WEIGHTS.passes,
      input.distinctPasses24h === null ||
        !Number.isFinite(input.distinctPasses24h)
        ? null
        : interpolate(input.distinctPasses24h, passesKnots),
      passesQuality,
    ),
    contribution(
      "downwind",
      "Downwind alignment",
      WEIGHTS.downwind,
      downwindValue,
      downwindQuality,
    ),
    contribution(
      "wind-speed",
      "Wind speed",
      WEIGHTS.wind,
      hasWindSpeed ? interpolate(input.weather?.windSpeedMps ?? 0, windKnots) : null,
      windQuality,
    ),
    contribution(
      "humidity",
      "Dry air",
      WEIGHTS.humidity,
      hasHumidity
        ? clamp01((80 - (input.weather?.relativeHumidityPct ?? 80)) / 70)
        : null,
      humidityQuality,
    ),
    contribution(
      "air-quality",
      "Air quality",
      WEIGHTS.air,
      airValue,
      usableAirQuality,
    ),
  ];

  const missingInputs: string[] = [];
  if (contributions[0].available === false) missingInputs.push("distance");
  if (contributions[1].available === false) missingInputs.push("age");
  if (contributions[2].available === false) missingInputs.push("confidence");
  if (contributions[3].available === false) missingInputs.push("frp");
  if (contributions[4].available === false) missingInputs.push("distinct-passes");
  if (input.weather === null || weatherQuality === 0) {
    missingInputs.push("weather");
  } else {
    if (!hasWindDirection || bearingQuality === 0) missingInputs.push("wind-direction");
    if (!hasWindSpeed) missingInputs.push("wind-speed");
    if (!hasHumidity) missingInputs.push("humidity");
  }
  if (airValue === null || airQuality === 0) missingInputs.push("air-quality");

  const dataConfidence = Math.round(
    100 * contributions.reduce((total, item) => total + item.weight * item.quality, 0),
  );
  const mandatoryAvailable = contributions[0].available && contributions[1].available;
  let score: number | null = null;
  let scoreRange: { low: number; high: number } | null = null;

  if (mandatoryAvailable) {
    const distance = (contributions[0].normalizedValue ?? 0) * distanceQuality;
    const age = (contributions[1].normalizedValue ?? 0) * ageQuality;
    const base = contributions[0].weightedValue + contributions[1].weightedValue;
    const gate = 0.25 + 0.75 * Math.sqrt(distance * age);
    const support = contributions
      .slice(2)
      .reduce((total, item) => total + item.weightedValue, 0);
    const missingSupport = contributions
      .slice(2)
      .filter(({ available }) => !available)
      .reduce((total, item) => total + item.weight, 0);
    score = Math.round(100 * clamp01(base + gate * support));
    scoreRange = {
      low: score,
      high: Math.round(100 * clamp01(base + gate * (support + missingSupport))),
    };
  }

  return {
    assetId: input.assetId,
    clusterId: input.clusterId,
    score,
    scoreRange,
    band: bandFor(score),
    contributions,
    reasons: contributions
      .filter(({ available, normalizedValue }) => available && (normalizedValue ?? 0) > 0)
      .map(({ code, label, weightedValue }) => ({
        code,
        label,
        contribution: weightedValue,
      })),
    missingInputs,
    completeness:
      !mandatoryAvailable ? "insufficient" : missingInputs.length === 0 ? "complete" : "partial",
    dataQuality:
      dataConfidence >= 90 ? "good" : dataConfidence >= 75 ? "adequate" : "limited",
    dataConfidence,
    canAutomateAlerts: mandatoryAvailable && dataConfidence >= 60,
  };
}
