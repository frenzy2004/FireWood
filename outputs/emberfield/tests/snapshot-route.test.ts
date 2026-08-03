import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { createSnapshotPostHandler } from "../app/api/snapshot/route";
import { DEMO_ASSET } from "../lib/fixtures/demo";
import { LocalWorkLimiter } from "../lib/server/local-request";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "../lib/server/repository";
import { buildSnapshot } from "../lib/server/snapshot";

type Row = Record<string, unknown>;

class RouteStatement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly database: RouteDatabase,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    return this;
  }

  async run(): Promise<unknown> {
    this.database.run(this.query, this.values);
    return { success: true };
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.all(this.query, this.values) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return (this.database.all(this.query, this.values)[0] as T | undefined) ?? null;
  }
}

class RouteDatabase implements D1DatabaseLike {
  readonly runs: Row[] = [];
  failPrune = false;
  readonly asset: Row = {
    id: "saved-asset",
    name: "Canonical saved ranch",
    category: "other",
    latitude: DEMO_ASSET.location.lat,
    longitude: DEMO_ASSET.location.lon,
    radius_km: DEMO_ASSET.radiusKm,
    notes: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-03T00:00:00.000Z",
  };

  prepare(query: string): D1PreparedStatementLike {
    return new RouteStatement(this, query);
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  run(query: string, values: unknown[]): void {
    const sql = query.replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO snapshot_runs")) {
      const [id, assetId, mode, generatedAt, snapshotJson, alertsJson, byteSize, createdAt] = values;
      this.runs.push({
        id,
        asset_id: assetId,
        mode,
        generated_at: generatedAt,
        snapshot_json: snapshotJson,
        alerts_json: alertsJson,
        byte_size: byteSize,
        created_at: createdAt,
      });
      return;
    }
    if (sql.startsWith("DELETE FROM snapshot_runs") && this.failPrune) {
      throw new Error("simulated prune failure");
    }
  }

  all(query: string, values: unknown[]): Row[] {
    const sql = query.replace(/\s+/g, " ").trim();
    if (sql.includes("FROM assets WHERE id = ?")) {
      return values[0] === this.asset.id ? [this.asset] : [];
    }
    if (sql.includes("FROM snapshot_runs")) {
      const [assetId, mode, since, maximumRunBytes, maximumHistoryBytes, limit] = values;
      let cumulativeBytes = 0;
      return this.runs
        .filter(
          (run) =>
            run.asset_id === assetId &&
            run.mode === mode &&
            String(run.generated_at) >= String(since),
        )
        .sort((left, right) => String(right.generated_at).localeCompare(String(left.generated_at)))
        .map((run) => {
          const byteSize = new TextEncoder().encode(
            String(run.snapshot_json) + String(run.alerts_json),
          ).byteLength;
          return { ...run, byte_size: byteSize };
        })
        .filter((run) => Number(run.byte_size) <= Number(maximumRunBytes))
        .map((run) => {
          cumulativeBytes += Number(run.byte_size);
          return { ...run, cumulativeBytes };
        })
        .filter((run) => run.cumulativeBytes <= Number(maximumHistoryBytes))
        .slice(0, Number(limit));
    }
    return [];
  }
}

const snapshotRequest = (mode: "fixture" | "live" = "fixture") =>
  new Request("http://localhost/api/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assetId: "saved-asset",
      mode,
      refresh: true,
    }),
  });

const savedLiveSnapshotBuilder = () =>
  vi.fn<typeof buildSnapshot>(async (input, dependencies) => {
    const fixture = await buildSnapshot(
      { ...input, mode: "fixture" },
      dependencies,
    );
    const liveState = (state: (typeof fixture.sources)[keyof typeof fixture.sources]) => ({
      ...state,
      mode: "live" as const,
    });
    return {
      ...fixture,
      mode: "live",
      sources: {
        firms: liveState(fixture.sources.firms),
        nws: liveState(fixture.sources.nws),
        airnow: liveState(fixture.sources.airnow),
        wfigs: liveState(fixture.sources.wfigs),
      },
    };
  });

describe("saved asset snapshot route", () => {
  it("rejects fixture mode for a saved asset before demo geography can be attributed to it", async () => {
    const database = new RouteDatabase();
    const snapshotBuilder = vi.fn(buildSnapshot);
    const handler = createSnapshotPostHandler({
      database,
      environment: {},
      limiter: new LocalWorkLimiter({ maximumConcurrent: 1 }),
      snapshotBuilder,
    });

    const response = await handler(snapshotRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Fixture mode is available only for the virtual demo asset",
    });
    expect(snapshotBuilder).not.toHaveBeenCalled();
    expect(database.runs).toHaveLength(0);
  });

  it("uses canonical D1 identity, persists refreshes, and returns compact readback", async () => {
    const database = new RouteDatabase();
    const snapshotBuilder = savedLiveSnapshotBuilder();
    const createHandler = () =>
      createSnapshotPostHandler({
        database,
        environment: {},
        now: () => new Date("2026-08-03T12:00:00.000Z"),
        limiter: new LocalWorkLimiter({ maximumConcurrent: 1 }),
        snapshotBuilder,
      });

    const firstResponse = await createHandler()(snapshotRequest("live"));
    const first = await firstResponse.json();
    const secondResponse = await createHandler()(snapshotRequest("live"));
    const second = await secondResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(first).toMatchObject({
      asset: { id: "saved-asset", name: "Canonical saved ranch" },
      persisted: true,
      snapshotId: expect.any(String),
      history24h: { runs: [expect.objectContaining({ id: expect.any(String) })] },
    });
    expect(second.history24h.runs).toHaveLength(2);
    expect(database.runs).toHaveLength(2);
    expect(snapshotBuilder).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: expect.objectContaining({ id: "saved-asset" }),
        mode: "live",
      }),
      expect.objectContaining({ refresh: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("returns an unambiguous persisted success when retention pruning fails", async () => {
    const database = new RouteDatabase();
    database.failPrune = true;
    const handler = createSnapshotPostHandler({
      database,
      environment: {},
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      limiter: new LocalWorkLimiter({ maximumConcurrent: 1 }),
      snapshotBuilder: savedLiveSnapshotBuilder(),
    });

    const response = await handler(snapshotRequest("live"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ persisted: true, snapshotId: expect.any(String) });
    expect(database.runs).toHaveLength(1);
  });

  it("rejects an oversized response envelope before saving another run", async () => {
    const database = new RouteDatabase();
    const common = {
      database,
      environment: {},
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      limiter: new LocalWorkLimiter({ maximumConcurrent: 1 }),
    };
    const first = await createSnapshotPostHandler({
      ...common,
      snapshotBuilder: savedLiveSnapshotBuilder(),
    })(snapshotRequest("live"));
    expect(first.status).toBe(200);

    const prior = database.runs[0];
    const priorSnapshot = JSON.parse(String(prior.snapshot_json)) as Awaited<
      ReturnType<typeof buildSnapshot>
    >;
    const priorClusterId = priorSnapshot.groups[0].cluster.id;
    prior.alerts_json = JSON.stringify([{
      id: "large-alert",
      type: "new-cluster",
      assetId: "saved-asset",
      clusterId: priorClusterId,
      dedupeKey: `saved-asset:live:${priorClusterId}:new-cluster:large`,
      createdAt: "2026-08-03T11:00:00.000Z",
      updatedAt: "2026-08-03T11:00:00.000Z",
      message: "a".repeat(2_000_000),
    }]);
    prior.byte_size = new TextEncoder().encode(
      String(prior.snapshot_json) + String(prior.alerts_json),
    ).byteLength;

    const baseBuilder = savedLiveSnapshotBuilder();
    const oversizedBuilder = vi.fn<typeof buildSnapshot>(async (input, dependencies) => {
      const snapshot = await baseBuilder(input, dependencies);
      const marker = `fixture:${"x".repeat(1_100_000)}`;
      snapshot.detections[0].source = marker;
      snapshot.groups[0].cluster.detections[0].source = marker;
      return snapshot;
    });
    const response = await createSnapshotPostHandler({
      ...common,
      limiter: new LocalWorkLimiter({ maximumConcurrent: 1 }),
      snapshotBuilder: oversizedBuilder,
    })(snapshotRequest("live"));

    expect(response.status).toBe(502);
    expect(database.runs).toHaveLength(1);
  });
});
