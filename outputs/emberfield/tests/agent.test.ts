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
  type AgentRepository,
  type SnapshotService,
} from "../lib/agent/tools";
import { runAgent } from "../lib/agent/ollama";
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
    saveSnapshot: vi.fn(async (snapshot) => {
      snapshots.push(snapshot);
    }),
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
    ollamaBaseUrl: "http://127.0.0.1:11434",
    now: () => fixedNow,
    ...overrides,
  };
}

describe("Gemma native tool loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes an allowlisted tool and preserves native call identity in history", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }, "call-inspect", 4),
      assistant("The orchard has elevated context because recent detections are nearby."),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("ok");
    expect(result.answer).toContain("elevated context");
    expect(result.trace[0]).toMatchObject({
      callId: "call-inspect",
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
    expect(continuation.messages.find(({ role }) => role === "tool")).toMatchObject({
      role: "tool",
      tool_name: "inspect_asset",
    });
    expect(continuation.messages.find(({ role }) => role === "tool"))
      .not.toHaveProperty("tool_call_id");
  });

  it("returns a bounded tool error for an unknown tool and continues", async () => {
    const ollama = mockOllama([
      toolCall("delete_asset", { assetId: asset.id }),
      assistant("That operation is not available. I can inspect verified evidence instead."),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("ok");
    expect(result.trace[0]).toMatchObject({
      toolName: "delete_asset",
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

  it("executes every allowlisted evidence tool and persists an explicit refresh", async () => {
    const argumentsByTool: Record<string, Record<string, unknown>> = {
      list_assets: {},
      inspect_asset: { assetId: asset.id },
      refresh_asset_data: { assetId: asset.id },
      get_activity_groups: { assetId: asset.id },
      get_weather_context: { assetId: asset.id },
      get_air_quality: { assetId: asset.id },
      get_official_incidents: { assetId: asset.id },
      get_timeline: { assetId: asset.id, hours: 24 },
      explain_assessment: { assetId: asset.id },
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
      assistant("All requested evidence tools returned source-labelled results."),
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
    expect(snapshots).toHaveLength(1);
    const continuation = ollama.requests[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    const toolMessages = continuation.messages.filter(({ role }) => role === "tool");
    expect(toolMessages).toHaveLength(9);
    expect(
      toolMessages.every(
        ({ content }) => new TextEncoder().encode(content).byteLength <= 12_000,
      ),
    ).toBe(true);
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

  it("enforces one 45-second deadline across the loop", async () => {
    vi.useFakeTimers();
    const timeoutFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "AbortError")),
        );
      });
    const pending = runAgent(runInput(timeoutFetch));
    await vi.advanceTimersByTimeAsync(45_000);

    await expect(pending).resolves.toMatchObject({ status: "timeout" });
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

  it("blocks a final numeric claim that was not present in visible tool evidence", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant("The verified context score is 999."),
    ]);

    const result = await runAgent(runInput(ollama.fetchImplementation));

    expect(result.status).toBe("grounding-error");
    expect(result.answer).not.toContain("999");
    expect(result.answer).toContain("source-grounded");
  });

  it("redacts credential-bearing URLs from tool messages and visible traces", async () => {
    const ollama = mockOllama([
      toolCall("inspect_asset", { assetId: asset.id }),
      assistant("Some source data is unavailable, so this briefing is limited."),
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
});

describe("agent contracts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes exactly the nine allowlisted agricultural evidence tools", () => {
    expect(AGENT_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
      "list_assets",
      "inspect_asset",
      "refresh_asset_data",
      "get_activity_groups",
      "get_weather_context",
      "get_air_quality",
      "get_official_incidents",
      "get_timeline",
      "explain_assessment",
    ]);
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
      assistant("The ranch briefing uses clearly labelled fixture detections and source states."),
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
