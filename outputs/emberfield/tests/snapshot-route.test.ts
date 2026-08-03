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
    }
  }

  all(query: string, values: unknown[]): Row[] {
    const sql = query.replace(/\s+/g, " ").trim();
    if (sql.includes("FROM assets WHERE id = ?")) {
      return values[0] === this.asset.id ? [this.asset] : [];
    }
    if (sql.includes("FROM snapshot_runs")) {
      const [assetId, mode, since, limit] = values;
      return this.runs
        .filter(
          (run) =>
            run.asset_id === assetId &&
            run.mode === mode &&
            String(run.generated_at) >= String(since),
        )
        .slice(0, Number(limit));
    }
    return [];
  }
}

const snapshotRequest = () =>
  new Request("http://localhost/api/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assetId: "saved-asset",
      mode: "fixture",
      refresh: true,
    }),
  });

describe("saved asset snapshot route", () => {
  it("uses canonical D1 identity, persists refreshes, and returns compact readback", async () => {
    const database = new RouteDatabase();
    const snapshotBuilder = vi.fn(buildSnapshot);
    const createHandler = () =>
      createSnapshotPostHandler({
        database,
        environment: {},
        now: () => new Date("2026-08-03T12:00:00.000Z"),
        limiter: new LocalWorkLimiter({ maximumConcurrent: 1 }),
        snapshotBuilder,
      });

    const firstResponse = await createHandler()(snapshotRequest());
    const first = await firstResponse.json();
    const secondResponse = await createHandler()(snapshotRequest());
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
        mode: "fixture",
      }),
      expect.objectContaining({ refresh: true, signal: expect.any(AbortSignal) }),
    );
  });
});
