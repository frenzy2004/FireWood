import { env } from "cloudflare:workers";
import { z } from "zod";

import { getD1Database } from "@/db";
import { boundingBox } from "@/lib/domain/geometry";
import { DEMO_ASSET, DEMO_BBOX } from "@/lib/fixtures/demo";
import {
  LocalWorkLimiter,
  rejectUnsafeLocalRequest,
} from "@/lib/server/local-request";
import {
  AssetRepository,
  type D1DatabaseLike,
} from "@/lib/server/repository";
import {
  compactSnapshotHistory,
  stabilizeSnapshot,
} from "@/lib/server/snapshot-history";
import { buildSnapshot } from "@/lib/server/snapshot";

const MAXIMUM_REQUEST_BYTES = 1_024;
const MAXIMUM_RESPONSE_BYTES = 4_000_000;
const SNAPSHOT_DEADLINE_MS = 25_000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RETENTION_WINDOW_MS = 48 * 60 * 60 * 1_000;

const snapshotRequestSchema = z.object({
  assetId: z.string().trim().min(1).max(128),
  mode: z.enum(["fixture", "live"]).default("live"),
  refresh: z.boolean().default(false),
}).strict();

class RequestBodyTooLargeError extends Error {}

async function boundedJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_REQUEST_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAXIMUM_REQUEST_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function boundedJsonResponse(
  payload: unknown,
  init: ResponseInit = {},
): Response {
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_RESPONSE_BYTES) {
    return Response.json(
      { error: "Snapshot response exceeds the local safety limit" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(body, { ...init, headers });
}

const snapshotLimiter = new LocalWorkLimiter({
  maximumConcurrent: 1,
  minimumIntervalMs: 500,
});

export interface SnapshotRouteDependencies {
  database?: D1DatabaseLike;
  environment?: Record<string, string | undefined>;
  limiter?: LocalWorkLimiter;
  now?: () => Date;
  snapshotBuilder?: typeof buildSnapshot;
}

export function createSnapshotPostHandler(
  dependencies: SnapshotRouteDependencies = {},
): (request: Request) => Promise<Response> {
  const limiter = dependencies.limiter ?? snapshotLimiter;
  const snapshotBuilder = dependencies.snapshotBuilder ?? buildSnapshot;

  return async (request: Request): Promise<Response> => {
    const rejected = rejectUnsafeLocalRequest(request, { requireJson: true });
    if (rejected) return rejected;

    let payload: unknown;
    try {
      payload = await boundedJsonBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return boundedJsonResponse(
          { error: "Snapshot request exceeds 1 KB" },
          { status: 413 },
        );
      }
      return boundedJsonResponse({ error: "Invalid snapshot request" }, { status: 400 });
    }
    const parsed = snapshotRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return boundedJsonResponse({ error: "Invalid snapshot request" }, { status: 400 });
    }

    const release = limiter.tryAcquire();
    if (!release) {
      return boundedJsonResponse(
        { error: "Another local snapshot refresh is already running" },
        { status: 429, headers: { "Retry-After": "1" } },
      );
    }

    const deadline = AbortSignal.timeout(SNAPSHOT_DEADLINE_MS);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      const isVirtualDemo = parsed.data.assetId === DEMO_ASSET.id;
      const repository = isVirtualDemo
        ? null
        : new AssetRepository(
            dependencies.database ??
              (getD1Database() as unknown as D1DatabaseLike),
            { now: dependencies.now },
          );
      const asset = isVirtualDemo
        ? DEMO_ASSET
        : await repository?.getAsset(parsed.data.assetId, signal);
      if (!asset) {
        return boundedJsonResponse({ error: "Saved asset was not found" }, { status: 404 });
      }

      const snapshot = await snapshotBuilder(
        {
          asset,
          bbox: isVirtualDemo
            ? DEMO_BBOX
            : boundingBox(asset.location, asset.radiusKm),
          mode: parsed.data.mode,
        },
        {
          environment:
            dependencies.environment ??
            (env as unknown as Record<string, string | undefined>),
          refresh: parsed.data.refresh,
          signal,
          now: dependencies.now,
        },
      );
      const generatedAtMs = Date.parse(snapshot.generatedAt);
      const historySince = new Date(generatedAtMs - HISTORY_WINDOW_MS).toISOString();
      const previousRuns = repository
        ? await repository.loadSnapshotHistory(
            asset.id,
            parsed.data.mode,
            historySince,
            signal,
          )
        : [];
      const existingAlerts = previousRuns.flatMap(({ alerts }) => alerts);
      const stabilized = stabilizeSnapshot(
        snapshot,
        previousRuns[0]?.snapshot ?? null,
        existingAlerts,
      );
      const storedRun = repository
        ? await repository.saveSnapshotRun(
            stabilized.snapshot,
            stabilized.alerts,
            signal,
          )
        : null;
      if (repository) {
        await repository.pruneSnapshotHistory(
          asset.id,
          parsed.data.mode,
          new Date(generatedAtMs - RETENTION_WINDOW_MS).toISOString(),
          signal,
        );
      }
      const history24h = compactSnapshotHistory(
        storedRun ? [storedRun, ...previousRuns] : [],
        historySince,
      );

      return boundedJsonResponse({
        ...stabilized.snapshot,
        snapshotId: storedRun?.id ?? null,
        persisted: storedRun !== null,
        alerts: stabilized.alerts,
        history24h,
      });
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return boundedJsonResponse(
          { error: "Snapshot refresh exceeded its local deadline" },
          { status: 504 },
        );
      }
      return boundedJsonResponse(
        { error: "Snapshot could not be built or persisted" },
        { status: 502 },
      );
    } finally {
      release();
    }
  };
}

export const POST = createSnapshotPostHandler();
