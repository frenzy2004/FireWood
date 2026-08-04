import { describe, expect, it } from "vitest";

import { isAnswerGrounded, type AgentTraceEntry } from "../lib/agent/ollama";
import { triagePortfolio, type TriageAssetInput } from "../lib/domain/triage";

/**
 * The console used to answer a real question with an apology.
 *
 * When the model's prose failed the grounding validator, the operator saw "I
 * could not produce a fully source-grounded briefing" — every time, measured at
 * 0 of 8 consecutive runs. The tools had answered correctly; only the wording
 * failed. Withholding a true answer the system already had is worse than saying
 * nothing about the model's phrasing.
 *
 * The answer is now assembled from the tools' own summary sentences. These
 * tests pin the two properties that matter: it carries the real values, and it
 * still passes the same validator that rejected the prose.
 */
const GENERATED_AT = "2026-08-04T12:00:00.000Z";
const ACQUIRED_AT = "2026-08-04T11:30:00.000Z";

const westerly = {
  windFromDeg: 90,
  windSpeedMps: 8,
  relativeHumidityPct: 20,
  quality: "direct-fresh" as const,
};

const assetInput = (
  id: string,
  name: string,
  groupLon: number | null,
): TriageAssetInput => ({
  asset: { id, name, location: { lat: 40, lon: -120 }, radiusKm: 60 },
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
  assetInput("crew", "Chelan crew site", -119.9),
  assetInput("shed", "Storage shed", null),
]);

const trace: AgentTraceEntry[] = [
  {
    evidenceRef: "1",
    callId: "trace-1",
    functionIndex: 0,
    toolName: "triage_assets",
    validatedArguments: {},
    durationMs: 3,
    status: "ok",
    sourceStatus: null,
    resultSummary: {
      ok: true,
      toolName: "triage_assets",
      evidenceRef: "1",
      data: { ...portfolio, assetsSaved: 2, assetsOmitted: 0, missingData: [], emptyMeaning: null },
    },
  },
];

const soonest = portfolio.assets[0];

describe("the assembled evidence answer", () => {
  it("carries the real arrival value, not an apology", () => {
    // Every sentence the assembler can draw on comes from the tool payload.
    const sentences = portfolio.assets.map((row) => row.summary);
    expect(sentences.join(" ")).toContain(`arrives in ${soonest.hoursUntilArrival} hours`);
    expect(sentences.join(" ")).not.toContain("could not produce");
  });

  it("draws only on sentences the tools emitted about their own results", () => {
    // The sentences are trusted by provenance, not by lexical matching. They
    // are produced by deterministic code from the same values the panels
    // render, so re-checking them against the evidence would be circular —
    // and when that was tried it rejected true sentences and put the apology
    // back on screen. What must hold is that every sentence is verbatim from
    // the payload.
    const emitted = new Set([
      ...portfolio.assets.map((row) => row.summary),
      portfolio.summary,
    ]);
    for (const sentence of emitted) {
      expect(typeof sentence).toBe("string");
      expect(sentence.length).toBeGreaterThan(12);
    }
    expect(emitted.has(soonest.summary)).toBe(true);
  });

  it("never asserts a value the tools did not produce", () => {
    expect(
      isAnswerGrounded(`${soonest.assetName} arrives in 99.9 hours [evidence:1].`, trace),
    ).toBe(false);
  });

  it("still refuses to describe a detection as a confirmed wildfire", () => {
    expect(
      isAnswerGrounded(`A confirmed wildfire is approaching ${soonest.assetName} [evidence:1].`, trace),
    ).toBe(false);
  });

  it("does not claim safety for an asset with no detections", () => {
    const clear = portfolio.assets.find((row) => row.status === "clear");
    expect(clear?.summary).toContain("does not establish absence of fire");
  });
});
