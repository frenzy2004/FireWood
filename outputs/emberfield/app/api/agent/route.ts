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

function virtualDemoRepository(): AgentRepository {
  return {
    listAssets: async () => [demoSavedAsset],
    listAlerts: async () => [],
    saveAgentRun: async () => {
      throw new Error("Virtual demo agent runs are not persisted");
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const payload: unknown = await request.json();
    const parsed = agentRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return Response.json({ error: "Invalid agent request" }, { status: 400 });
    }

    const environment = env as unknown as Record<string, string | undefined>;
    const isVirtualDemo = parsed.data.assetId === DEMO_ASSET.id;
    if (isVirtualDemo && parsed.data.mode === "live") {
      return Response.json(
        { error: "The virtual demo asset is available only in fixture mode" },
        { status: 400 },
      );
    }
    const mode = isVirtualDemo ? "fixture" : (parsed.data.mode ?? "live");
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
  }
}
