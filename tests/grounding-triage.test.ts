import { describe, expect, it } from "vitest";

import { isAnswerGrounded, type AgentTraceEntry } from "../lib/agent/ollama";
import { triagePortfolio, type TriageAssetInput } from "../lib/domain/triage";

/**
 * Grounding coverage for portfolio triage.
 *
 * The evidence here is built by the real `triagePortfolio` rather than written
 * by hand, so the payload the validator sees is the payload the tool emits. A
 * hand-rolled fixture drifts from production and quietly stops testing it.
 */
const GENERATED_AT = "2026-08-04T12:00:00.000Z";
const ACQUIRED_AT = "2026-08-04T11:30:00.000Z";

const westerly = {
  windFromDeg: 90,
  windSpeedMps: 8,
  relativeHumidityPct: 20,
  quality: "direct-fresh" as const,
};

const asset = (
  id: string,
  name: string,
  lon: number,
  groupLon: number | null,
): TriageAssetInput => ({
  asset: { id, name, location: { lat: 40, lon }, radiusKm: 60 },
  generatedAt: GENERATED_AT,
  detectionCount: groupLon === null ? 0 : 12,
  groups:
    groupLon === null
      ? []
      : [
          {
            centroid: { lat: 40, lon: groupLon },
            detectionCount: 12,
            latestAcquiredAt: ACQUIRED_AT,
            weather: westerly,
            score: 40,
            band: "elevated-context",
            missingInputs: [],
          },
        ],
  air: null,
});

const portfolio = triagePortfolio([
  asset("crew", "Chelan crew site", -120, -119.9),
  asset("orchard", "North orchard", -120, -119.7),
  asset("barn", "Hay barn", -120, -120.4),
  asset("shed", "Storage shed", -120, null),
]);

const trace: AgentTraceEntry[] = [
  {
    evidenceRef: "1",
    callId: "trace-1",
    functionIndex: 0,
    toolName: "triage_assets",
    validatedArguments: {},
    durationMs: 4,
    status: "ok",
    sourceStatus: null,
    resultSummary: {
      ok: true,
      toolName: "triage_assets",
      evidenceRef: "1",
      data: {
        ...portfolio,
        assetsSaved: 4,
        assetsOmitted: 0,
        method:
          "Each asset's groups are scored for smoke arrival, then assets are ranked by status and imminence. Ordering is deterministic. Not a fire-spread prediction.",
        missingData: [],
        emptyMeaning: null,
      },
    },
  },
];

const soonest = portfolio.assets[0];

describe("portfolio triage claims can be grounded", () => {
  it("grounds the portfolio-level count", () => {
    expect(
      isAnswerGrounded(
        `${portfolio.assetsInbound} assets of ${portfolio.assetsScanned} scanned have smoke inbound [evidence:1].`,
        trace,
      ),
    ).toBe(true);
  });

  it("grounds the soonest asset and its arrival", () => {
    expect(
      isAnswerGrounded(
        `${soonest.assetName} has smoke inbound and arrives in ${soonest.hoursUntilArrival} hours [evidence:1].`,
        trace,
      ),
    ).toBe(true);
  });

  it("grounds a not-upwind asset", () => {
    const barn = portfolio.assets.find((row) => row.assetName === "Hay barn")!;
    expect(barn.status).toBe("activity-nearby");
    expect(
      isAnswerGrounded(
        `Hay barn has ${barn.groupCount} detection groups nearby but none upwind [evidence:1].`,
        trace,
      ),
    ).toBe(true);
  });
});

describe("portfolio triage rejects unsupported claims", () => {
  it.each([
    ["an invented arrival time", `${soonest.assetName} arrives in 99.9 hours [evidence:1].`],
    ["an inflated inbound count", `9 assets of 4 scanned have smoke inbound [evidence:1].`],
    ["an inflated scan count", `1 asset of 40 scanned has smoke inbound [evidence:1].`],
    ["an uncited claim", `${soonest.assetName} has smoke inbound.`],
  ])("rejects %s", (_label, answer) => {
    expect(isAnswerGrounded(answer, trace)).toBe(false);
  });

  it("still refuses confirmed-wildfire language about a ranked asset", () => {
    expect(
      isAnswerGrounded(
        `A confirmed wildfire is approaching ${soonest.assetName} [evidence:1].`,
        trace,
      ),
    ).toBe(false);
  });
});
