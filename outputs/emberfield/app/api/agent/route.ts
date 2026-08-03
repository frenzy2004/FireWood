import { env } from "cloudflare:workers";

import { getD1Database } from "@/db";
import { agentRequestSchema, runAgent } from "@/lib/agent/ollama";
import type {
  AgentRepository,
  SnapshotService,
} from "@/lib/agent/tools";
import { DEMO_ASSET, DEMO_BBOX } from "@/lib/fixtures/demo";
import { getRuntimeConfig } from "@/lib/server/config";
import {
  LocalWorkLimiter,
  rejectUnsafeLocalRequest,
} from "@/lib/server/local-request";
import {
  AssetRepository,
  type D1DatabaseLike,
  type SavedAsset,
} from "@/lib/server/repository";
import { buildSnapshot } from "@/lib/server/snapshot";

const demoSavedAsset: SavedAsset = {
  ...DEMO_ASSET,
  category: "other",
  notes: null,
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const MAXIMUM_AGENT_REQUEST_BYTES = 16_384;

function virtualDemoRepository(): AgentRepository {
  return {
    listAssets: async () => [demoSavedAsset],
    listAlerts: async () => [],
    saveAgentRun: async () => {
      throw new Error("Virtual demo agent runs are not persisted");
    },
  };
}

const agentLimiter = new LocalWorkLimiter({ maximumConcurrent: 1 });

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectUnsafeLocalRequest(request, { requireJson: true });
  if (rejected) return rejected;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAXIMUM_AGENT_REQUEST_BYTES
  ) {
    return Response.json(
      { error: "Agent request exceeds 16 KB" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }
  let release: (() => void) | null = null;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAXIMUM_AGENT_REQUEST_BYTES) {
      return Response.json(
        { error: "Agent request exceeds 16 KB" },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const parsed = agentRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return Response.json({ error: "Invalid agent request" }, { status: 400 });
    }
    const isVirtualDemo = parsed.data.assetId === DEMO_ASSET.id;
    if (parsed.data.mode === "fixture" && !isVirtualDemo) {
      return Response.json(
        { error: "Fixture mode is available only for the virtual demo asset" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    release = agentLimiter.tryAcquire();
    if (!release) {
      return Response.json(
        { error: "Another local agent run is already active" },
        {
          status: 429,
          headers: { "Cache-Control": "no-store", "Retry-After": "1" },
        },
      );
    }

    const environment = env as unknown as Record<string, string | undefined>;
    const mode = isVirtualDemo
      ? (parsed.data.mode ?? "fixture")
      : (parsed.data.mode ?? "live");
    const repository: AgentRepository = isVirtualDemo
      ? virtualDemoRepository()
      : new AssetRepository(
          getD1Database() as unknown as D1DatabaseLike,
        );
    const snapshotService: SnapshotService = async (asset, options) =>
      buildSnapshot(
        {
          asset,
          ...(isVirtualDemo ? { bbox: DEMO_BBOX } : {}),
          mode,
        },
        {
          environment,
          signal: options.signal,
          refresh: options.refresh,
        },
      );
    const config = getRuntimeConfig(environment);
    const result = await runAgent({
      ...parsed.data,
      repository,
      snapshotService,
      fetchImpl: fetch,
      ollamaBaseUrl: config.ollama.baseUrl,
      mode,
      signal: request.signal,
    });

    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid agent request" }, { status: 400 });
    }
    return Response.json(
      { error: "The local evidence agent is unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    release?.();
  }
}
