import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRepository, SnapshotService } from "../lib/agent/tools";
import {
  isAnswerGrounded,
  runAgent,
  type AgentTraceEntry,
} from "../lib/agent/ollama";
import type { SavedAsset } from "../lib/server/repository";

const asset: SavedAsset = {
  id: "asset-1",
  name: "Sierra Vista Almonds",
  category: "orchard",
  location: { lat: 41.049033, lon: -116.543867 },
  radiusKm: 45,
  notes: null,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-03T10:00:00.000Z",
};

function evidence(
  resultSummary: unknown,
  toolName = "inspect_asset",
  evidenceRef = "1",
): AgentTraceEntry {
  return {
    evidenceRef,
    callId: `trace-${evidenceRef}`,
    functionIndex: 0,
    toolName,
    validatedArguments: {},
    durationMs: 1,
    status: "ok",
    sourceStatus: null,
    resultSummary,
  };
}

const assistant = (content: string) => ({
  model: "gemma4:12b",
  done: true,
  done_reason: "stop",
  message: { role: "assistant", content },
});

function toolCall(name: string, id: string) {
  return {
    model: "gemma4:12b",
    done: true,
    done_reason: "stop",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id,
          type: "function",
          function: { index: 0, name, arguments: {} },
        },
      ],
    },
  };
}

function runHarness(responses: unknown[], signal?: AbortSignal) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected Ollama request");
    return Response.json(response);
  });
  const repository: AgentRepository = {
    listAssets: vi.fn(async () => [asset]),
    listAlerts: vi.fn(async () => []),
    saveAgentRun: vi.fn(async (input) => ({
      ...input,
      id: "agent-run-1",
      createdAt: "2026-08-03T12:00:00.000Z",
    })),
  };
  const snapshotService: SnapshotService = vi.fn(async () => {
    throw new Error("Snapshot service was not expected");
  });
  return {
    requests,
    repository,
    result: runAgent({
      prompt: "Brief the saved asset.",
      assetId: asset.id,
      repository,
      snapshotService,
      fetchImpl,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      signal,
    }),
  };
}

describe("claim-level agent grounding", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a negated containment phrase negate later spreading", () => {
    const trace = [
      evidence(
        {
          data: {
            incidents: [
              { name: "Antelope Creek", type: "WF", percentContained: 35 },
            ],
          },
        },
        "get_official_incidents",
      ),
    ];

    expect(
      isAnswerGrounded(
        "The wildfire is not contained because it is spreading. [evidence:1]",
        trace,
      ),
    ).toBe(false);
  });

  it.each(["cluster", "group"])(
    "blocks unsupported %s movement assembled from separate tools",
    (subject) => {
      const trace = [
        evidence(
          { data: { clusterId: "cluster-1" } },
          subject === "cluster" ? "inspect_asset" : "get_activity_groups",
          "1",
        ),
        evidence(
          { data: { weather: { relativeHumidityPct: 22 } } },
          "get_weather_context",
          "2",
        ),
      ];

      expect(
        isAnswerGrounded(
          `The ${subject} is moving. [evidence:1][evidence:2]`,
          trace,
        ),
      ).toBe(false);
    },
  );

  it("does not allow factual prose inside an uncited planning suggestion", () => {
    const trace = [
      evidence(
        { data: { assets: [{ category: "orchard" }] } },
        "list_assets",
      ),
    ];

    expect(
      isAnswerGrounded(
        "The saved orchard is available. [evidence:1] Consider the moon green while asking low-risk questions.",
        trace,
      ),
    ).toBe(false);
  });

  it("allows only the exact uncited planning-question sentence", () => {
    const trace = [
      evidence(
        { data: { assets: [{ category: "orchard" }] } },
        "list_assets",
      ),
    ];

    expect(
      isAnswerGrounded(
        "The saved orchard is available. [evidence:1] Consider low-risk preparation questions.",
        trace,
      ),
    ).toBe(true);
  });

  it("preserves numeric signs when checking evidence", () => {
    const trace = [
      evidence({ data: { asset: { location: { lon: -116.543867 } } } }),
    ];

    expect(
      isAnswerGrounded(
        "The asset longitude is 116.543867. [evidence:1]",
        trace,
      ),
    ).toBe(false);
    expect(
      isAnswerGrounded(
        "The asset longitude is -116.543867. [evidence:1]",
        trace,
      ),
    ).toBe(true);
  });

  it("requires a claimed number to belong to the named field", () => {
    const trace = [
      evidence({
        data: { assessment: { score: 73, dataConfidence: 100 } },
      }),
    ];

    expect(
      isAnswerGrounded(
        "The assessment score is 100. [evidence:1]",
        trace,
      ),
    ).toBe(false);
    expect(
      isAnswerGrounded(
        "The assessment score is 73. [evidence:1]",
        trace,
      ),
    ).toBe(true);
  });

  it("accepts common labels for a numeric evidence field", () => {
    const trace = [
      evidence(
        { data: { contexts: [{ weather: { relativeHumidityPct: 22 } }] } },
        "get_weather_context",
      ),
    ];

    expect(
      isAnswerGrounded(
        "Relative humidity is 22 percent. [evidence:1]",
        trace,
      ),
    ).toBe(true);
  });

  it("does not borrow live or partial state from another source", () => {
    const trace = [
      evidence({
        data: {
          sources: {
            firms: { mode: "fixture", status: "ok" },
            nws: { mode: "live", status: "partial" },
          },
        },
      }),
    ];

    expect(
      isAnswerGrounded("FIRMS mode is live. [evidence:1]", trace),
    ).toBe(false);
    expect(
      isAnswerGrounded("FIRMS status is partial. [evidence:1]", trace),
    ).toBe(false);
    expect(
      isAnswerGrounded("The source mode is live. [evidence:1]", trace),
    ).toBe(false);
    expect(
      isAnswerGrounded(
        "FIRMS mode is fixture and status is ok. [evidence:1]",
        trace,
      ),
    ).toBe(true);
  });

  it("matches a named source to its returned source-state object", () => {
    const trace = [
      evidence(
        {
          data: {
            source: { source: "NWS", mode: "fixture", status: "ok" },
          },
        },
        "get_weather_context",
      ),
    ];

    expect(
      isAnswerGrounded(
        "NWS mode is fixture and status is ok. [evidence:1]",
        trace,
      ),
    ).toBe(true);
  });

  it("does not manufacture facts from a successful tool name", () => {
    const trace = [
      evidence(
        { data: { asset: null, activityGroups: [] } },
        "inspect_asset",
      ),
    ];

    expect(
      isAnswerGrounded(
        "Nearby activity is available. [evidence:1]",
        trace,
      ),
    ).toBe(false);
  });

  it("uses server-generated public trace identities and private raw protocol identities", async () => {
    const rawCallId = ["eyJhbGciOiJIUzI1NiJ9", "payload", "signature"].join(".");
    const rawToolName = ["sk", "proj", "opaque", "credential"].join("-");
    const run = runHarness([
      toolCall(rawToolName, rawCallId),
      assistant("That operation is not available."),
    ]);

    const result = await run.result;

    expect(result.trace[0]).toMatchObject({
      callId: "trace-1",
      toolName: "[unknown-tool]",
      status: "unknown-tool",
    });
    expect(JSON.stringify(result.trace)).not.toContain(rawCallId);
    expect(JSON.stringify(result.trace)).not.toContain(rawToolName);
    expect(JSON.stringify(run.requests[1])).toContain(rawCallId);
    expect(JSON.stringify(run.requests[1])).toContain(rawToolName);
  });

  it("does not automatically persist an agent run", async () => {
    const run = runHarness([
      toolCall("list_assets", "raw-call-id"),
      assistant("The saved orchard is available. [evidence:1]"),
    ]);

    const result = await run.result;

    expect(result).toMatchObject({
      status: "ok",
      persistenceStatus: "not-persisted",
    });
    expect(run.repository.saveAgentRun).not.toHaveBeenCalled();
  });

  it("stops immediately when its caller aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    const repository: AgentRepository = {
      listAssets: vi.fn(async () => [asset]),
      listAlerts: vi.fn(async () => []),
      saveAgentRun: vi.fn(),
    };
    const pending = runAgent({
      prompt: "Brief the saved asset.",
      assetId: asset.id,
      repository,
      snapshotService: vi.fn(),
      fetchImpl,
      signal: controller.signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const settledOnCallerAbort = settled;
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;

    expect(settledOnCallerAbort).toBe(true);
  });
});
