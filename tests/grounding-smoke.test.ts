import { describe, expect, it } from "vitest";

import { isAnswerGrounded, type AgentTraceEntry } from "../lib/agent/ollama";

/**
 * Grounding coverage for smoke-advection claims.
 *
 * Two gaps were found by running the real agent against the Camp Fire replay:
 *
 *   1. The new advection fields had no entries in FIELD_LABEL_ALIASES, so the
 *      only way to ground a number was the raw camelCase label. Natural prose
 *      such as "arrives in 4.2 hours" could never match its own evidence.
 *
 *   2. ISO timestamps were only indexed through `numericClaims`, whose
 *      lookbehind rejects the hour in `T19` and which reads a fractional
 *      second as 42.523 rather than 42. Any briefing quoting a clock time was
 *      ungroundable against the timestamp it came from — for every tool that
 *      returns one, not just this one.
 *
 * Both fixes are additive: they surface values already present in the evidence.
 * The rejection tests below exist to prove that nothing was loosened.
 */
const trace: AgentTraceEntry[] = [
  {
    evidenceRef: "3",
    callId: "trace-3",
    functionIndex: 0,
    toolName: "get_smoke_arrival",
    validatedArguments: { assetId: "replay-camp-fire-colusa-orchard" },
    durationMs: 1,
    status: "ok",
    sourceStatus: null,
    resultSummary: {
      ok: true,
      toolName: "get_smoke_arrival",
      evidenceRef: "3",
      data: {
        assetId: "replay-camp-fire-colusa-orchard",
        mode: "fixture",
        arrivals: [
          {
            clusterId: "cluster-a538a17c",
            detectionCount: 3,
            arrival: {
              distanceKm: 103.6,
              transportBearingDeg: 240,
              offAxisDeg: 26,
              rawTransitHours: 2.9,
              transitHours: 4.3,
              estimatedArrivalAt: "2018-11-08T19:10:42.523Z",
              hoursUntilArrival: 4.2,
              status: "inbound",
              confidence: "moderate",
              missingData: [],
            },
          },
        ],
        missingData: [],
      },
    },
  },
];

describe("smoke-advection claims can be grounded", () => {
  it.each([
    ["arrival in hours", "Smoke arrives in 4.2 hours [evidence:3]."],
    ["transit time", "Transit time is 4.3 hours [evidence:3]."],
    ["distance", "The distance is 103.6 km [evidence:3]."],
    ["status only", "Smoke transport status is inbound [evidence:3]."],
    ["confidence", "Confidence is moderate [evidence:3]."],
  ])("%s", (_label, answer) => {
    expect(isAnswerGrounded(answer, trace)).toBe(true);
  });

  it("grounds a clock time quoted from an ISO timestamp", () => {
    // 19 and 42 are unreachable through numericClaims alone.
    expect(
      isAnswerGrounded(
        "Estimated arrival at 19:10:42 [evidence:3].",
        trace,
      ),
    ).toBe(true);
  });
});

describe("nothing was loosened", () => {
  it.each([
    ["wrong arrival hours", "Smoke arrives in 9.9 hours [evidence:3]."],
    ["wrong distance", "The distance is 250.1 km [evidence:3]."],
    ["wrong transit", "Transit time is 12.7 hours [evidence:3]."],
    ["wrong clock time", "Estimated arrival at 03:15:00 [evidence:3]."],
    ["uncited claim", "Smoke arrives in 4.2 hours."],
    ["citation that does not exist", "Smoke arrives in 4.2 hours [evidence:99]."],
  ])("rejects %s", (_label, answer) => {
    expect(isAnswerGrounded(answer, trace)).toBe(false);
  });

  it("still refuses to call a detection a confirmed wildfire", () => {
    expect(
      isAnswerGrounded(
        "A confirmed wildfire is 103.6 km away and the distance is closing [evidence:3].",
        trace,
      ),
    ).toBe(false);
  });
});
