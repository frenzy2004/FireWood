import { env } from "cloudflare:workers";
import { z } from "zod";

import { getD1Database } from "@/db";
import { boundingBox } from "@/lib/domain/geometry";
import { triagePortfolio, type TriageAssetInput } from "@/lib/domain/triage";
import { VIRTUAL_ASSETS, getVirtualAsset } from "@/lib/fixtures/registry";
import {
  LocalWorkLimiter,
  rejectUnsafeLocalRequest,
} from "@/lib/server/local-request";
import {
  AssetRepository,
  type D1DatabaseLike,
} from "@/lib/server/repository";
import { buildSnapshot } from "@/lib/server/snapshot";

const MAXIMUM_REQUEST_BYTES = 1_024;
const TRIAGE_DEADLINE_MS = 60_000;

/**
 * Assets scanned in one request.
 *
 * Each costs a snapshot, and a live snapshot hits four external sources. This
 * mirrors the agent tool's own cap so the console and the briefing never
 * disagree about how much of the portfolio was examined.
 */
const TRIAGE_ASSET_LIMIT = 6;

const triageRequestSchema = z
  .object({ mode: z.enum(["fixture", "live"]).default("live") })
  .strict();

const triageLimiter = new LocalWorkLimiter({
  maximumConcurrent: 1,
  minimumIntervalMs: 500,
});

export interface TriageRouteDependencies {
  database?: D1DatabaseLike;
  environment?: Record<string, string | undefined>;
  limiter?: LocalWorkLimiter;
  snapshotBuilder?: typeof buildSnapshot;
}

export function createTriagePostHandler(
  dependencies: TriageRouteDependencies = {},
): (request: Request) => Promise<Response> {
  const limiter = dependencies.limiter ?? triageLimiter;
  const snapshotBuilder = dependencies.snapshotBuilder ?? buildSnapshot;

  return async (request: Request): Promise<Response> => {
    const rejected = rejectUnsafeLocalRequest(request, { requireJson: true });
    if (rejected) return rejected;

    let parsedBody: unknown;
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAXIMUM_REQUEST_BYTES) {
        return Response.json({ error: "Triage request exceeds 1 KB" }, { status: 413 });
      }
      parsedBody = bytes.byteLength === 0
        ? {}
        : (JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    } catch {
      return Response.json({ error: "Invalid triage request" }, { status: 400 });
    }
    const parsed = triageRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      return Response.json({ error: "Invalid triage request" }, { status: 400 });
    }

    const release = limiter.tryAcquire();
    if (!release) {
      return Response.json(
        { error: "Another local triage scan is already running" },
        { status: 429, headers: { "Retry-After": "1" } },
      );
    }

    const deadline = AbortSignal.timeout(TRIAGE_DEADLINE_MS);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      // The rail always shows the virtual assets, pinned ahead of saved ones, so
      // the scan must cover them in either mode. Ranking only D1 rows in live
      // mode made a fresh install report "no saved assets were scanned" while
      // two assets sat visible on screen — the console contradicting itself.
      const virtual = VIRTUAL_ASSETS.map((entry) => entry.asset);
      const stored = parsed.data.mode === "fixture"
        ? []
        : await new AssetRepository(
            dependencies.database ??
              (getD1Database() as unknown as D1DatabaseLike),
          ).listAssets(signal);
      const saved = [
        ...virtual,
        ...stored.filter((asset) => !virtual.some((entry) => entry.id === asset.id)),
      ];

      const scanned = saved.slice(0, TRIAGE_ASSET_LIMIT);
      const inputs: TriageAssetInput[] = [];
      const failures: Array<{ assetId: string; assetName: string }> = [];

      for (const asset of scanned) {
        const virtual = getVirtualAsset(asset.id);
        try {
          const snapshot = await snapshotBuilder(
            {
              asset,
              bbox: virtual
                ? virtual.bbox
                : boundingBox(asset.location, asset.radiusKm),
              mode: virtual ? parsed.data.mode : "live",
            },
            {
              environment:
                dependencies.environment ??
                (env as unknown as Record<string, string | undefined>),
              signal,
            },
          );
          inputs.push({
            asset,
            generatedAt: snapshot.generatedAt,
            detectionCount: snapshot.detections.length,
            groups: snapshot.groups.map((group) => ({
              centroid: group.cluster.centroid,
              detectionCount: group.cluster.detectionCount,
              latestAcquiredAt: group.cluster.latestAcquiredAt,
              weather: group.weather,
              score: group.assessment.score,
              band: group.assessment.band,
              missingInputs: group.assessment.missingInputs,
            })),
            air: snapshot.air,
            // Only "clear" if FIRMS actually answered.
            detectionsAvailable: snapshot.sources.firms.status === "ok"
              || snapshot.sources.firms.status === "partial",
          });
        } catch {
          // One unreachable asset must not blank the whole portfolio. It is
          // named as a failure rather than quietly ranked as clear.
          failures.push({ assetId: asset.id, assetName: asset.name });
        }
      }

      const portfolio = triagePortfolio(inputs);
      return Response.json(
        {
          ...portfolio,
          mode: parsed.data.mode,
          assetsSaved: saved.length,
          assetsOmitted: Math.max(0, saved.length - scanned.length),
          failures,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return Response.json(
          { error: "Triage scan exceeded its local deadline" },
          { status: 504, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { error: "Triage scan could not be completed" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      release();
    }
  };
}

export const POST = createTriagePostHandler();
