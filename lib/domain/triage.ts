// Portfolio triage.
//
// Every other surface in EmberField answers a question about one asset. An
// operator with an orchard, a barn, a livestock pasture, a storage site and a
// crew in the field has a different question, and it is the one that matters
// most:
//
//   "Which of my places is in trouble right now?"
//
// That is a judgement across assets, not a lookup, so it cannot come from the
// single-asset panels. This module reduces each asset's evidence to one
// comparable row and orders them by how much attention they deserve.
//
// Pure and deterministic. Ordering and status are decided here in code; the
// model's job is to read the ranking out, not to invent it.

import { distanceKm } from "./geometry";
import { estimateSmokeArrival, type SmokeArrival } from "./smoke";
import type { Asset, AirQualityContext, WeatherContext } from "./types";

/**
 * Attention order. Lower sorts first.
 *
 * Smoke that is on its way outranks smoke that has already landed, because
 * arrival is the only one of the two an operator can still act before.
 */
export const TRIAGE_STATUS_RANK = {
  "smoke-inbound": 0,
  "smoke-likely-present": 1,
  "activity-nearby": 2,
  "not-assessable": 3,
  clear: 4,
} as const;

export type TriageStatus = keyof typeof TRIAGE_STATUS_RANK;

export interface TriageGroupInput {
  centroid: { lat: number; lon: number };
  detectionCount: number;
  latestAcquiredAt: string;
  weather: WeatherContext | null;
  score: number | null;
  band: string;
  missingInputs: string[];
}

export interface TriageAssetInput {
  asset: Asset;
  generatedAt: string;
  detectionCount: number;
  groups: TriageGroupInput[];
  air: AirQualityContext | null;
  /**
   * Whether the detection feed actually answered.
   *
   * An empty result means "no detections" only if the source was reachable and
   * configured. Without a FIRMS key the feed returns nothing, and calling that
   * `clear` would have the console assert safety it never checked — the same
   * mistake as ranking an unreachable asset as fine.
   */
  detectionsAvailable?: boolean;
}

export interface AssetTriage {
  assetId: string;
  assetName: string;
  status: TriageStatus;
  /** Hours until the soonest inbound plume, or null when nothing is inbound. */
  hoursUntilArrival: number | null;
  estimatedArrivalAt: string | null;
  /** Distance to the closest detection group, regardless of wind direction. */
  nearestGroupKm: number | null;
  detectionCount: number;
  groupCount: number;
  /** Highest deterministic context score across this asset's groups. */
  worstScore: number | null;
  band: string;
  missingData: string[];
  /** A sentence the model can quote rather than paraphrase. */
  summary: string;
}

export interface PortfolioTriage {
  assets: AssetTriage[];
  assetsScanned: number;
  assetsInbound: number;
  /** Portfolio-level sentence, safe to quote verbatim. */
  summary: string;
}

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function assetSummary(row: Omit<AssetTriage, "summary">): string {
  switch (row.status) {
    case "smoke-inbound":
      return `${row.assetName} has smoke inbound and arrives in ${row.hoursUntilArrival} hours. The nearest detection group is ${row.nearestGroupKm} km away.`;
    case "smoke-likely-present":
      return `${row.assetName} has smoke that likely arrived already; the estimated arrival of ${row.estimatedArrivalAt} has passed. The nearest detection group is ${row.nearestGroupKm} km away.`;
    case "activity-nearby":
      return `${row.assetName} has ${plural(row.groupCount, "detection group")} nearby but none upwind. The nearest detection group is ${row.nearestGroupKm} km away.`;
    case "not-assessable":
      return `${row.assetName} cannot be assessed. Missing: ${row.missingData.join(", ") || "transport inputs"}.`;
    default:
      return `${row.assetName} has no recent satellite detections in range. Absence of detections does not establish absence of fire.`;
  }
}

/**
 * Reduce one asset's evidence to a single comparable row.
 *
 * Arrival is evaluated per group and the soonest inbound one wins, because an
 * operator needs the earliest moment smoke can reach them, not an average.
 */
export function triageAsset(input: TriageAssetInput): AssetTriage {
  const now = new Date(input.generatedAt);
  const arrivals: Array<{ group: TriageGroupInput; arrival: SmokeArrival }> =
    input.groups.map((group) => ({
      group,
      arrival: estimateSmokeArrival({
        asset: input.asset.location,
        source: group.centroid,
        detectedAt: group.latestAcquiredAt,
        windFromDeg: group.weather?.windFromDeg ?? null,
        windSpeedMps: group.weather?.windSpeedMps ?? null,
        now,
      }),
    }));

  const inbound = arrivals
    .filter((row) => row.arrival.status === "inbound")
    .sort(
      (left, right) =>
        (left.arrival.hoursUntilArrival ?? Infinity) -
        (right.arrival.hoursUntilArrival ?? Infinity),
    );
  const arrived = arrivals.filter(
    (row) => row.arrival.status === "likely-arrived",
  );

  const nearest = input.groups.length === 0
    ? null
    : Math.min(
        ...input.groups.map((group) =>
          distanceKm(input.asset.location, group.centroid),
        ),
      );

  const scores = input.groups
    .map((group) => group.score)
    .filter((score): score is number => typeof score === "number");

  const missingData = [
    ...new Set(arrivals.flatMap((row) => row.arrival.missingData)),
  ];

  const detectionsAvailable = input.detectionsAvailable !== false;
  if (!detectionsAvailable) missingData.unshift("detection-feed");

  const status: TriageStatus =
    inbound.length > 0
      ? "smoke-inbound"
      : arrived.length > 0
        ? "smoke-likely-present"
        : input.groups.length === 0
          // No groups is only "clear" when the feed actually answered.
          ? (detectionsAvailable ? "clear" : "not-assessable")
          : missingData.length > 0
            ? "not-assessable"
            : "activity-nearby";

  const soonest = inbound[0]?.arrival ?? arrived[0]?.arrival ?? null;

  const row = {
    assetId: input.asset.id,
    assetName: input.asset.name,
    status,
    hoursUntilArrival: inbound[0]?.arrival.hoursUntilArrival ?? null,
    estimatedArrivalAt: soonest?.estimatedArrivalAt ?? null,
    nearestGroupKm: nearest === null ? null : round(nearest, 1),
    detectionCount: input.detectionCount,
    groupCount: input.groups.length,
    worstScore: scores.length === 0 ? null : Math.max(...scores),
    band: input.groups[0]?.band ?? "no-activity",
    missingData,
  };

  return { ...row, summary: assetSummary(row) };
}

/**
 * Rank a portfolio so the asset needing attention first appears first.
 *
 * Ties inside a status break on imminence, then on proximity — an operator
 * comparing two inbound sites cares which one is sooner, not which is nearer.
 */
export function triagePortfolio(inputs: TriageAssetInput[]): PortfolioTriage {
  const assets = inputs
    .map(triageAsset)
    .sort((left, right) => {
      const byStatus =
        TRIAGE_STATUS_RANK[left.status] - TRIAGE_STATUS_RANK[right.status];
      if (byStatus !== 0) return byStatus;
      const byArrival =
        (left.hoursUntilArrival ?? Infinity) -
        (right.hoursUntilArrival ?? Infinity);
      if (byArrival !== 0) return byArrival;
      return (left.nearestGroupKm ?? Infinity) - (right.nearestGroupKm ?? Infinity);
    });

  const inboundAssets = assets.filter((row) => row.status === "smoke-inbound");
  const assessable = assets.filter((row) => row.status !== "not-assessable");
  const summary =
    assets.length === 0
      ? "No saved assets were scanned."
      : assessable.length === 0
        // "Nothing inbound" would be a safety claim drawn from evidence that
        // was never obtained. Say that no asset could be assessed instead.
        ? `No asset could be assessed. ${plural(assets.length, "asset")} scanned, all missing required evidence.`
        : inboundAssets.length === 0
          ? `No saved asset has smoke inbound. ${plural(assessable.length, "asset")} assessed of ${assets.length} scanned. Wind shifts invalidate this immediately.`
          : `${plural(inboundAssets.length, "asset")} of ${assets.length} scanned ${inboundAssets.length === 1 ? "has" : "have"} smoke inbound. ${inboundAssets[0].assetName} is soonest and arrives in ${inboundAssets[0].hoursUntilArrival} hours.`;

  return {
    assets,
    assetsScanned: assets.length,
    assetsInbound: inboundAssets.length,
    summary,
  };
}
