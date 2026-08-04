import { afterEach, describe, expect, it, vi } from "vitest";

const workerEnvironment = vi.hoisted(() => ({
  DB: undefined as unknown,
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  OLLAMA_MODEL: "gemma4:12b",
}));
vi.mock("cloudflare:workers", () => ({ env: workerEnvironment }));

import { POST as agentRoute } from "../app/api/agent/route";
import {
  AGENT_TOOL_DEFINITIONS,
  boundToolResult,
  sanitizeAgentValue,
  type AgentRepository,
  type SnapshotService,
} from "../lib/agent/tools";
import {
  AGENT_MAX_CALLS_PER_ROUND,
  AGENT_TIMEOUT_MS,
  isAnswerGrounded,
  runAgent,
  type AgentTraceEntry,
} from "../lib/agent/ollama";
import type { SavedAsset } from "../lib/server/repository";
import { buildSnapshot, type Snapshot } from "../lib/server/snapshot";

const fixedNow = new Date("2026-08-03T12:00:00.000Z");
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

const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id = "call-1",
  index = 0,
) => ({
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
        function: { index, name, arguments: args },
      },
    ],
  },
});

const assistant = (content: string) => ({
  model: "gemma4:12b",
  done: true,
  done_reason: "stop",
  total_duration: 2_000_000_000,
  message: { role: "assistant", content },
});

function mockOllama(responses: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImplementation: typeof fetch = vi.fn(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected Ollama request");
    return Response.json(response);
  });
  return { fetchImplementation, requests };
}

async function fixtureSnapshot(): Promise<Snapshot> {
  return buildSnapshot(
    { asset, mode: "fixture" },
    { now: () => fixedNow },
  );
}

function harness(snapshotTransform?: (snapshot: Snapshot) => Snapshot) {
  const snapshots: Snapshot[] = [];
  const repository: AgentRepository = {
    listAssets: vi.fn(async () => [asset]),
    listAlerts: vi.fn(async () => []),
    saveAgentRun: vi.fn(async (input) => ({
      ...input,
      id: "agent-run-1",
      createdAt: fixedNow.toISOString(),
    })),
  };
  const snapshotService: SnapshotService = vi.fn(async () => {
    const snapshot = await fixtureSnapshot();
    return snapshotTransform ? snapshotTransform(snapshot) : snapshot;
  });
  return { repository, snapshotService, snapshots };
}

function runInput(
  fetchImpl: typeof fetch,
  overrides: Record<string, unknown> = {},
) {
  const { repository, snapshotService } = harness();
  return {
    prompt: "Brief me on verified activity near the orchard.",
    assetId: asset.id,
    repository,
    snapshotService,
    fetchImpl,
    geocodeService: vi.fn(async (address: string) => ({
      status: "ok" as const,
      benchmark: { id: "4", name: "Public_AR_Current" },
      match: {
        matchedAddress: address.toUpperCase(),
        location: { lat: 38.8977, lon: -77.0365 },
        tigerLineId: "123",
        side: "L",
        addressComponents: {},
      },
      mode: "live" as const,
      source: "US Census Geocoder" as const,
      fetchedAt: fixedNow.toISOString(),
    })),
    ollamaBaseUrl: "http://127.0.0.1:11434",
    now: () => fixedNow,
    ...overrides,
  };
}

describe("Gemma native tool loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a generated trace identity while preserving native call identity in history", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }, "call-inspect", 4),
      assistant("The orchard has elevated context because recent detections are nearby. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("ok");
    expect(result.answer).toContain("elevated context");
    expect(result.trace[0]).toMatchObject({
      callId: "trace-1",
      functionIndex: 4,
      toolName: "inspect_asset",
      validatedArguments: { assetId: asset.id },
      status: "ok",
      sourceStatus: expect.objectContaining({
        firms: expect.objectContaining({ mode: "fixture", status: "ok" }),
      }),
    });
    expect(result.trace[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.trace[0].resultSummary).toBeDefined();

    expect(ollama.requests[0]).toMatchObject({
      model: "gemma4:12b",
      stream: false,
      think: false,
      options: { num_predict: 256, temperature: 0.1 },
    });
    const firstRequest = ollama.requests[0] as {
      messages: Array<Record<string, unknown>>;
      tools: Array<{ function: { name: string } }>;
    };
    expect(firstRequest.tools.map((tool) => tool.function.name)).toEqual(
      AGENT_TOOL_DEFINITIONS.map((tool) => tool.function.name),
    );
    expect(firstRequest.messages[0].content).toContain("detections");
    expect(firstRequest.messages[0].content).toContain("Follow local emergency officials");

    const continuation = ollama.requests[1] as {
      messages: Array<Record<string, unknown>>;
    };
    const assistantHistory = continuation.messages.find(
      ({ role }) => role === "assistant",
    ) as { tool_calls: Array<{ id: string; function: { index: number } }> };
    expect(assistantHistory.tool_calls[0]).toMatchObject({
      id: "call-inspect",
      function: { index: 4 },
    });
    const inspectEvidence = continuation.messages.find(
      ({ role }) => role === "tool",
    ) as { content: string };
    expect(inspectEvidence).toMatchObject({
      role: "tool",
      tool_name: "inspect_asset",
    });
    expect(inspectEvidence).not.toHaveProperty("tool_call_id");
    expect(JSON.parse(inspectEvidence.content).data).not.toHaveProperty(
      "unacknowledgedAlertCount",
    );
  });

  it("scopes a starter to one native tool and a three-round local budget", async () => {
    const ollama = mockOllama(Array.from({ length: 3 }, (_, index) =>
      toolCall("inspect_asset", {}, `call-inspect-${index}`, index),
    ));

    const result = await runAgent(runInput(ollama.fetchImplementation, {
      prompt: "What evidence is missing?",
    }));

    expect(result).toMatchObject({ status: "round-limit", rounds: 3 });
    expect(ollama.requests).toHaveLength(3);
    const firstRequest = ollama.requests[0] as {
      keep_alive?: string;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string } }>;
    };
    expect(firstRequest.keep_alive).toBe("30m");
    expect(firstRequest.tools.map((tool) => tool.function.name)).toEqual(["inspect_asset"]);
    expect(firstRequest.messages.find(({ role }) => role === "user")?.content).toBe(
      `What evidence is missing?\n\nActive asset id: ${asset.id}`,
    );
  });

  it("returns a bounded tool error for an unknown tool and continues", async () => {
    const ollama = mockOllama([
      toolCall("delete_asset", { assetId: asset.id }),
      assistant("That operation is not available. I can inspect verified evidence instead."),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
    expect(result.trace[0]).toMatchObject({
      toolName: "[unknown-tool]",
      status: "unknown-tool",
      validatedArguments: null,
    });
    const continuation = ollama.requests[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(
      JSON.parse(continuation.messages.find(({ role }) => role === "tool")!.content),
    ).toMatchObject({ ok: false, error: "unknown-tool" });
  });

  it("executes every allowlisted evidence tool without persisting refresh snapshots", async () => {
    const argumentsByTool: Record<string, Record<string, unknown>> = {
      list_assets: {},
      triage_assets: {},
      inspect_asset: { assetId: asset.id },
      refresh_asset_data: { assetId: asset.id },
      get_activity_groups: { assetId: asset.id },
      get_weather_context: { assetId: asset.id },
      get_air_quality: { assetId: asset.id },
      get_official_incidents: { assetId: asset.id },
      get_smoke_arrival: { assetId: asset.id },
      get_timeline: { assetId: asset.id, hours: 24 },
      explain_assessment: { assetId: asset.id },
      geocode_location: { address: "1600 Pennsylvania Avenue NW, Washington, DC" },
    };
    const calls = AGENT_TOOL_DEFINITIONS.map((definition, index) => ({
      id: `call-${index}`,
      type: "function",
      function: {
        index,
        name: definition.function.name,
        arguments: argumentsByTool[definition.function.name],
      },
    }));
    const ollama = mockOllama([
      {
        model: "gemma4:12b",
        done: true,
        done_reason: "stop",
        message: { role: "assistant", content: "", tool_calls: calls },
      },
      assistant("The saved orchard is available. [evidence:1]"),
    ]);
    const { repository, snapshotService, snapshots } = harness();

    const result = await runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });

    expect(result.status).toBe("ok");
    expect(result.trace.map(({ toolName }) => toolName)).toEqual(
      AGENT_TOOL_DEFINITIONS.map((definition) => definition.function.name),
    );
    expect(result.trace.every(({ status }) => status === "ok")).toBe(true);
    expect(snapshots).toHaveLength(0);
    const continuation = ollama.requests[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    const toolMessages = continuation.messages.filter(({ role }) => role === "tool");
    expect(toolMessages).toHaveLength(12);
    expect(
      toolMessages.every(
        ({ content }) => new TextEncoder().encode(content).byteLength <= 6_000,
      ),
    ).toBe(true);
  });

  it("lets Gemma call the live Census geocoder as a native evidence tool", async () => {
    const geocodeService = vi.fn(async (address: string) => ({
      status: "ok" as const,
      benchmark: { id: "4", name: "Public_AR_Current" },
      match: {
        matchedAddress: address.toUpperCase(),
        location: { lat: 38.8977, lon: -77.0365 },
        tigerLineId: "123",
        side: "L",
        addressComponents: {},
      },
      mode: "live" as const,
      source: "US Census Geocoder" as const,
      fetchedAt: fixedNow.toISOString(),
    }));
    const ollama = mockOllama([
      toolCall("geocode_location", {
        address: "1600 Pennsylvania Avenue NW, Washington, DC",
      }),
      assistant("The Census match is in Washington, DC. [evidence:1]"),
    ]);

    const result = await runAgent(
      runInput(ollama.fetchImplementation, { geocodeService }),
    );

    expect(result.status).toBe("ok");
    expect(geocodeService).toHaveBeenCalledWith(
      "1600 Pennsylvania Avenue NW, Washington, DC",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.trace[0]).toMatchObject({
      toolName: "geocode_location",
      status: "ok",
      sourceStatus: {
        census: expect.objectContaining({
          source: "US Census Geocoder",
          mode: "live",
          status: "ok",
        }),
      },
      resultSummary: expect.objectContaining({
        data: expect.objectContaining({
          match: expect.objectContaining({
            location: { lat: 38.8977, lon: -77.0365 },
          }),
        }),
      }),
    });
  });

  it("rejects invalid coordinate arguments before a tool can reach the snapshot service", async () => {
    const ollama = mockOllama([
      toolCall("get_weather_context", {
        assetId: asset.id,
        latitude: 91,
        longitude: -116.5,
      }),
      assistant("Weather evidence was unavailable because the coordinates were invalid."),
    ]);
    const { repository, snapshotService } = harness();

    const result = await runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });

    expect(result.trace[0]).toMatchObject({
      toolName: "get_weather_context",
      status: "validation-error",
      validatedArguments: null,
    });
    expect(snapshotService).not.toHaveBeenCalled();
  });

  it("reports Ollama offline without exposing its configured authority", async () => {
    const offlineFetch: typeof fetch = async () => {
      throw new TypeError("fetch failed at http://127.0.0.1:11434/api/chat");
    };

    const result = await runAgent(runInput(offlineFetch));

    expect(result).toMatchObject({ status: "offline", model: "gemma4:12b" });
    expect(result.answer).toContain("Local Gemma is offline");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  it("rejects a non-loopback Ollama authority before fetch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(
      runAgent(
        runInput(fetchImplementation, {
          ollamaBaseUrl: "https://example.com/ollama",
        }),
      ),
    ).rejects.toThrow("loopback");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("enforces one wall-clock deadline across the loop", async () => {
    vi.useFakeTimers();
    const timeoutFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "AbortError")),
        );
      });
    const pending = runAgent(runInput(timeoutFetch));
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ status: "timeout" });
  });

  it("applies the wall-clock deadline while an evidence tool is stalled", async () => {
    vi.useFakeTimers();
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
    ]);
    const { repository } = harness();
    const stalledSnapshotService: SnapshotService = async () =>
      new Promise<Snapshot>(() => undefined);
    const settled = vi.fn();

    void runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService: stalledSnapshotService,
    }).then(settled);
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);
    await Promise.resolve();

    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ status: "timeout" }),
    );
  });

  it("never starts automatic agent-run persistence", async () => {
    const ollama = mockOllama([
      toolCall("list_assets", {}),
      assistant("The saved orchard is available. [evidence:1]"),
    ]);
    const { repository, snapshotService } = harness();
    repository.saveAgentRun = vi.fn(
      async () => new Promise<never>(() => undefined),
    );
    const pending = runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        status: "ok",
        persistenceStatus: "not-persisted",
      }),
    );
    expect(repository.saveAgentRun).not.toHaveBeenCalled();
  });

  it("stops after six tool-call rounds", async () => {
    const calls = Array.from({ length: 6 }, (_, index) =>
      toolCall("list_assets", {}, `call-${index}`, index),
    );
    const ollama = mockOllama(calls);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result).toMatchObject({ status: "round-limit", rounds: 6 });
    expect(result.trace).toHaveLength(6);
    expect(ollama.requests).toHaveLength(6);
  });

  it("rejects a round exceeding the per-round tool-call cap before execution", async () => {
    const excessiveCalls = Array.from(
      { length: AGENT_MAX_CALLS_PER_ROUND + 1 },
      (_, index) => ({
        id: `call-${index}`,
        type: "function",
        function: {
          index,
          name: "list_assets",
          arguments: {},
        },
      }),
    );
    const ollama = mockOllama([
      {
        message: { role: "assistant", content: "", tool_calls: excessiveCalls },
      },
    ]);
    const { repository, snapshotService } = harness();

    const result = await runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });

    expect(result.status).toBe("round-limit");
    expect(result.trace).toEqual([]);
    expect(repository.listAssets).not.toHaveBeenCalled();
  });

  it("stops before executing more than eighteen tool calls in one run", async () => {
    const responseWithCalls = (start: number, count: number) => ({
      message: {
        role: "assistant",
        content: "",
        tool_calls: Array.from({ length: count }, (_, offset) => ({
          id: `call-${start + offset}`,
          type: "function",
          function: {
            index: offset,
            name: "list_assets",
            arguments: {},
          },
        })),
      },
    });
    const ollama = mockOllama([
      responseWithCalls(0, 9),
      responseWithCalls(9, 9),
      responseWithCalls(18, 1),
    ]);
    const { repository, snapshotService } = harness();

    const result = await runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });

    expect(result.status).toBe("round-limit");
    expect(result.trace).toHaveLength(18);
    expect(repository.listAssets).toHaveBeenCalledTimes(18);
  });

  it("allows only one refresh call per run without an uncancellable snapshot write", async () => {
    const ollama = mockOllama([
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            toolCall("refresh_asset_data", { assetId: asset.id }, "refresh-1")
              .message.tool_calls[0],
            toolCall("refresh_asset_data", { assetId: asset.id }, "refresh-2")
              .message.tool_calls[0],
          ],
        },
      },
      assistant("The asset evidence was refreshed. [evidence:1]"),
    ]);
    const { repository, snapshotService, snapshots } = harness();

    const result = await runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });

    expect(result.status).toBe("ok");
    expect(result.trace.map(({ status }) => status)).toEqual([
      "ok",
      "tool-error",
    ]);
    expect(snapshotService).toHaveBeenCalledTimes(1);
    expect(snapshotService).toHaveBeenCalledWith(
      asset,
      expect.objectContaining({
        refresh: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(snapshots).toHaveLength(0);
  });

  it("blocks a final numeric claim that was not present in visible tool evidence", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant("The verified context score is 999. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
    expect(result.answer).not.toContain("999");
    expect(result.answer).toContain("source-grounded");
  });

  it("rejects an evidence briefing that skipped successful tools", async () => {
    const ollama = mockOllama([
      assistant("No recent detections were found near the orchard."),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
    expect(result.trace).toEqual([]);
  });

  it("rejects a nonnumeric condition claim without an evidence citation", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant("The source is live and confirms a wildfire."),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it("accepts a server-issued citation to successful tool evidence", async () => {
    const ollama = mockOllama([
      toolCall("list_assets", {}),
      assistant("The saved orchard is available. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));
    const continuation = ollama.requests[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    const toolMessage = continuation.messages.find(({ role }) => role === "tool");

    expect(result.status).toBe("ok");
    expect(result.trace[0]).toMatchObject({ evidenceRef: "1", status: "ok" });
    expect(JSON.parse(toolMessage?.content ?? "{}")).toMatchObject({
      evidenceRef: "1",
    });
  });

  it("accepts an ordinary active-asset fixture summary from inspect evidence", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant(
        "The active asset is Sierra Vista Almonds, which is currently in fixture mode [evidence:1].",
      ),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("ok");
  });

  it("does not let list_assets evidence bless unrelated factual prose", async () => {
    const ollama = mockOllama([
      toolCall("list_assets", {}),
      assistant("The moon over the orchard is green. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it("rejects generic prose even when it carries a successful citation", async () => {
    const ollama = mockOllama([
      toolCall("list_assets", {}),
      assistant("This is current verified evidence. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it("checks numeric claims against citations on the same sentence", async () => {
    const ollama = mockOllama([
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            toolCall("list_assets", {}, "asset-call", 0).message.tool_calls[0],
            toolCall("get_air_quality", { assetId: asset.id }, "air-call", 1)
              .message.tool_calls[0],
          ],
        },
      },
      assistant(
        "The saved orchard has AQI 71. [evidence:1] AirNow reports AQI 71. [evidence:2]",
      ),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it.each([
    "Satellite detections are approaching the orchard. [evidence:1]",
    "Satellite detections are reaching the orchard. [evidence:1]",
    "Satellite detections are spreading toward the orchard. [evidence:1]",
    "An evacuation is underway. [evidence:1]",
    "The orchard is safe. [evidence:1]",
  ])("blocks an unsupported safety-sensitive assertion: %s", async (answer) => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant(answer),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it("does not treat an uncited safety assertion as a harmless heading", async () => {
    const ollama = mockOllama([
      toolCall("list_assets", {}),
      assistant(
        "The saved orchard is available. [evidence:1] The orchard is safe:",
      ),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it("blocks affirmative wildfire movement even when those words appear in evidence", () => {
    const trace: AgentTraceEntry[] = [
      {
        evidenceRef: "1",
        callId: "call-1",
        functionIndex: 0,
        toolName: "inspect_asset",
        validatedArguments: { assetId: asset.id },
        durationMs: 1,
        status: "ok",
        sourceStatus: null,
        resultSummary: {
          data: {
            asset: { category: "orchard" },
            unsafeUpstreamText: "wildfire moving toward orchard",
          },
        },
      },
    ];

    expect(
      isAnswerGrounded(
        "The wildfire is moving toward the orchard. [evidence:1]",
        trace,
      ),
    ).toBe(false);
  });

  it("allows factual wind movement from weather evidence", async () => {
    const ollama = mockOllama([
      toolCall("get_weather_context", { assetId: asset.id }),
      assistant("The fixture wind is moving with speed 7.2. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("ok");
  });

  it("allows a low-risk preparation question without treating it as a risk claim", () => {
    const trace: AgentTraceEntry[] = [
      {
        evidenceRef: "1",
        callId: "call-1",
        functionIndex: 0,
        toolName: "list_assets",
        validatedArguments: {},
        durationMs: 1,
        status: "ok",
        sourceStatus: null,
        resultSummary: { data: { assets: [{ category: "orchard" }] } },
      },
    ];

    expect(
      isAnswerGrounded(
        "The saved orchard is available. [evidence:1] Consider low-risk preparation questions.",
        trace,
      ),
    ).toBe(true);
  });

  it("requires a matching successful official-incident result for a confirmed wildfire", async () => {
    const ollama = mockOllama([
      toolCall("get_official_incidents", { assetId: asset.id }),
      assistant("Juniper Ridge is a confirmed wildfire. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it("accepts a matching confirmed wildfire from successful official evidence", async () => {
    const ollama = mockOllama([
      toolCall("get_official_incidents", { assetId: asset.id }),
      assistant("Antelope Creek is a confirmed wildfire. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("ok");
  });

  it("does not accept inspect evidence as official wildfire confirmation", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant("Antelope Creek is a confirmed wildfire. [evidence:1]"),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
  });

  it("allows an explicit safety disclaimer backed by relevant evidence", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant(
        "The fixture satellite detections do not establish that the orchard is safe. [evidence:1]",
      ),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("ok");
  });

  it("redacts credential-bearing URLs from tool messages and visible traces", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant("Some source data is unavailable, so this briefing is limited. [evidence:1]"),
    ]);
    const { repository, snapshotService } = harness((snapshot) => ({
      ...snapshot,
      sources: {
        ...snapshot.sources,
        firms: {
          ...snapshot.sources.firms,
          sourceUrl:
            "https://firms.modaps.eosdis.nasa.gov/api/area/csv/super-secret/feed/bbox/1",
        },
        airnow: {
          ...snapshot.sources.airnow,
          sourceUrl:
            "https://www.airnowapi.org/current/?API_KEY=super-secret",
        },
      },
    }));

    const result = await runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });

    expect(JSON.stringify(result.trace)).not.toContain("super-secret");
    expect(JSON.stringify(ollama.requests[1])).not.toContain("super-secret");
  });

  it("sanitizes model-controlled trace identity while preserving private protocol identity", async () => {
    const callSecret = "call-secret-value";
    const nameSecret = "name-secret-value";
    const rawCallId = `  https://example.test/call?api_key=${callSecret}`;
    const rawToolName = `  https://[broken]?token=${nameSecret}`;
    const ollama = mockOllama([
      toolCall(rawToolName, {}, rawCallId),
      assistant("That operation is not available."),
    ]);
    const { repository, snapshotService } = harness();

    const result = await runAgent({
      ...runInput(ollama.fetchImplementation),
      repository,
      snapshotService,
    });
    const continuation = ollama.requests[1] as {
      messages: Array<Record<string, unknown>>;
    };

    expect(JSON.stringify(result.trace)).not.toContain(callSecret);
    expect(JSON.stringify(result.trace)).not.toContain(nameSecret);
    expect(repository.saveAgentRun).not.toHaveBeenCalled();
    expect(JSON.stringify(continuation.messages)).toContain(callSecret);
    expect(result.trace[0]).toMatchObject({
      callId: "trace-1",
      toolName: "[unknown-tool]",
    });
  });

  it("redacts malformed URL-like values instead of returning them unchanged", () => {
    const malformed = "  https://[broken]?api_key=malformed-secret";

    expect(sanitizeAgentValue(malformed)).toBe("[redacted-url]");
  });
});

describe("agent contracts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes exactly the twelve allowlisted agricultural evidence tools", () => {
    expect(AGENT_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
      "list_assets",
      "triage_assets",
      "inspect_asset",
      "refresh_asset_data",
      "get_activity_groups",
      "get_weather_context",
      "get_air_quality",
      "get_official_incidents",
      "get_smoke_arrival",
      "get_timeline",
      "explain_assessment",
      "geocode_location",
    ]);
  });

  it("describes refresh as a fresh read rather than unsupported persistence", () => {
    const refreshTool = AGENT_TOOL_DEFINITIONS.find(
      ({ function: definition }) => definition.name === "refresh_asset_data",
    );

    expect(refreshTool?.function.description).toContain("Refresh current evidence");
    expect(refreshTool?.function.description).not.toMatch(/persist/i);
  });

  it("caps serialized tool evidence before it enters Ollama history", () => {
    const result = boundToolResult("inspect_asset", {
      rows: Array.from({ length: 500 }, (_, index) => ({
        index,
        detail: "bounded-evidence".repeat(20),
      })),
    });

    expect(new TextEncoder().encode(result.json).byteLength).toBeLessThanOrEqual(6_000);
  });

  it("caps the final serialized envelope for escape-heavy multibyte evidence", () => {
    const result = boundToolResult("inspect_asset", {
      rows: Array.from({ length: 100 }, (_, index) => ({
        index,
        detail: `\"\\wildfire🔥${index}`.repeat(200),
      })),
    });

    expect(new TextEncoder().encode(result.json).byteLength).toBeLessThanOrEqual(6_000);
    expect(() => JSON.parse(result.json)).not.toThrow();
  });

  it("rejects invalid agent route payloads before accessing Worker services", async () => {
    const response = await agentRoute(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "", assetId: "asset-1" }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("briefs the virtual default demo from fixture evidence without a D1 asset", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: "demo-antelope-ranch" }),
      assistant("The ranch briefing uses clearly labelled fixture detections and source states. [evidence:1]"),
    ]);
    vi.stubGlobal("fetch", ollama.fetchImplementation);
    workerEnvironment.DB = undefined;

    const response = await agentRoute(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Inspect the default ranch and give a source-grounded briefing.",
          assetId: "demo-antelope-ranch",
        }),
      }),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      status: "ok",
      trace: [
        expect.objectContaining({
          toolName: "inspect_asset",
          sourceStatus: expect.objectContaining({
            firms: expect.objectContaining({ mode: "fixture" }),
          }),
        }),
      ],
    });
    expect(ollama.requests).toHaveLength(2);
  });

  it("rejects an unsupported requested evidence mode", async () => {
    const response = await agentRoute(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Brief me",
          assetId: "demo-antelope-ranch",
          mode: "demo",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
