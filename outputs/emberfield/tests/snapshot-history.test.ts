import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Alert } from "../lib/domain/types";
import {
  compactSnapshotHistory,
  stabilizeSnapshot,
} from "../lib/server/snapshot-history";
import type { Snapshot } from "../lib/server/snapshot";
import {
  AssetRepository,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "../lib/server/repository";

type Row = Record<string, unknown>;

class RunStatement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly database: RunDatabase,
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

class RunDatabase implements D1DatabaseLike {
  readonly runs: Row[] = [];
  readonly batchSizes: number[] = [];

  prepare(query: string): D1PreparedStatementLike {
    return new RunStatement(this, query);
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    this.batchSizes.push(statements.length);
    if (statements.length > 100) throw new Error("D1 batch exceeded 100 statements");
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
    if (sql.startsWith("DELETE FROM snapshot_runs")) {
      const [assetId, mode, cutoff] = values;
      for (let index = this.runs.length - 1; index >= 0; index -= 1) {
        const run = this.runs[index];
        if (
          run.asset_id === assetId &&
          run.mode === mode &&
          String(run.generated_at) < String(cutoff)
        ) {
          this.runs.splice(index, 1);
        }
      }
    }
  }

  all(query: string, values: unknown[]): Row[] {
    const sql = query.replace(/\s+/g, " ").trim();
    if (!sql.includes("FROM snapshot_runs")) return [];
    const [assetId, mode, since, limit] = values;
    return this.runs
      .filter(
        (run) =>
          run.asset_id === assetId &&
          run.mode === mode &&
          String(run.generated_at) >= String(since),
      )
      .sort((left, right) => String(right.generated_at).localeCompare(String(left.generated_at)))
      .slice(0, Number(limit));
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function snapshot(assetId: string, generatedAt: string, clusterId = "current-cluster"): Snapshot {
  const detection = {
    id: `${assetId}-detection`,
    fingerprint: "shared-member",
    source: "fixture:VIIRS_NOAA20_NRT",
    lat: 41.05,
    lon: -116.54,
    acquiredAt: generatedAt,
    satellite: "NOAA-20",
    confidence: "high" as const,
    frpMw: 24,
  };
  const source = {
    mode: "fixture" as const,
    status: "ok" as const,
    source: "fixture",
    sourceUrl: null,
    fetchedAt: generatedAt,
    observedAt: generatedAt,
  };
  return {
    mode: "fixture",
    generatedAt,
    asset: {
      id: assetId,
      name: assetId,
      location: { lat: 41.049, lon: -116.544 },
      radiusKm: 45,
    },
    bbox: {
      north: 42,
      south: 40,
      east: -115,
      west: -117,
      crossesAntimeridian: false,
    },
    detections: [detection],
    groups: [
      {
        cluster: {
          id: clusterId,
          centroid: { lat: detection.lat, lon: detection.lon },
          detections: [detection],
          memberFingerprints: ["shared-member"],
          detectionCount: 1,
          firstAcquiredAt: generatedAt,
          latestAcquiredAt: generatedAt,
          satellites: [detection.satellite],
          maxConfidence: detection.confidence,
          maxFrpMw: detection.frpMw,
        },
        weather: null,
        assessment: {
          assetId,
          clusterId,
          score: 70,
          scoreRange: { low: 65, high: 75 },
          band: "elevated-context",
          contributions: [],
          reasons: [],
          missingInputs: [],
          completeness: "complete",
          dataQuality: "good",
          dataConfidence: 90,
          canAutomateAlerts: true,
        },
        officialMatch: null,
      },
    ],
    incidents: [],
    perimeters: [],
    air: null,
    sources: { firms: source, nws: source, airnow: source, wfigs: source },
  };
}

describe("snapshot history migration", () => {
  it("upgrades a seeded 0000 database without destroying existing rows", () => {
    const migrationDirectory = join(process.cwd(), "drizzle");
    const migration = readdirSync(migrationDirectory)
      .filter((name) => /^0001_.*\.sql$/.test(name))
      .sort()[0];
    expect(migration).toBeDefined();

    const directory = mkdtempSync(join(tmpdir(), "emberfield-migration-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "history.sqlite");
    const initialSql = readFileSync(join(migrationDirectory, "0000_emberfield.sql"), "utf8")
      .replaceAll("--> statement-breakpoint", "");
    execFileSync("/usr/bin/sqlite3", [database], { input: initialSql });
    execFileSync("/usr/bin/sqlite3", [database], {
      input: `INSERT INTO assets VALUES ('seed','Seed','field',1,2,10,NULL,'2026-08-03T00:00:00.000Z','2026-08-03T00:00:00.000Z');`,
    });
    const upgradeSql = readFileSync(join(migrationDirectory, migration), "utf8")
      .replaceAll("--> statement-breakpoint", "");
    execFileSync("/usr/bin/sqlite3", [database], { input: upgradeSql });

    expect(execFileSync("/usr/bin/sqlite3", [database, "SELECT count(*) FROM assets;"]).toString().trim())
      .toBe("1");
    expect(execFileSync("/usr/bin/sqlite3", [database, "SELECT count(*) FROM snapshot_runs;"]).toString().trim())
      .toBe("0");
  });
});

describe("run-scoped snapshot history", () => {
  it("persists sanitized snapshots and reads back only the requested asset and mode", async () => {
    const database = new RunDatabase();
    let sequence = 0;
    const repository = new AssetRepository(database, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      createId: () => `run-${++sequence}`,
    });
    const first = snapshot("asset-a", "2026-08-03T10:00:00.000Z");
    first.sources.nws.sourceUrl = "https://api.weather.gov/grid?token=secret";
    await repository.saveSnapshotRun(first, []);
    await repository.saveSnapshotRun(snapshot("asset-b", "2026-08-03T11:00:00.000Z"), []);
    const live = snapshot("asset-a", "2026-08-03T11:30:00.000Z");
    live.mode = "live";
    await repository.saveSnapshotRun(live, []);

    const history = await repository.loadSnapshotHistory(
      "asset-a",
      "fixture",
      "2026-08-02T12:00:00.000Z",
    );

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ assetId: "asset-a", mode: "fixture" });
    expect(JSON.stringify(history)).not.toContain("secret");
  });

  it("never submits more than 100 statements in one legacy D1 batch", async () => {
    const database = new RunDatabase();
    const repository = new AssetRepository(database);
    const oversized = snapshot("asset-a", "2026-08-03T10:00:00.000Z");
    oversized.detections = Array.from({ length: 120 }, (_, index) => ({
      ...oversized.detections[0],
      id: `detection-${index}`,
      fingerprint: `fingerprint-${index}`,
    }));

    await repository.saveSnapshot(oversized);

    expect(database.batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...database.batchSizes)).toBeLessThanOrEqual(100);
  });

  it("reuses a prior track across changing cluster ids and scopes alerts by mode", () => {
    const previous = snapshot("asset-a", "2026-08-03T10:00:00.000Z", "track-existing");
    const current = snapshot("asset-a", "2026-08-03T11:00:00.000Z", "cluster-recomputed");
    current.groups[0].cluster.satellites.push("NOAA-21");

    const result = stabilizeSnapshot(current, previous, []);

    expect(result.snapshot.groups[0].cluster.id).toBe("track-existing");
    expect(result.alerts).toEqual([
      expect.objectContaining({
        type: "new-satellite",
        dedupeKey: "asset-a:fixture:track-existing:new-satellite",
      }),
    ]);
  });

  it("returns bounded compact history without embedding prior full snapshots", () => {
    const alerts: Alert[] = Array.from({ length: 250 }, (_, index) => ({
      id: `alert-${index}`,
      type: "new-cluster",
      assetId: "asset-a",
      clusterId: "track-a",
      dedupeKey: `asset-a:fixture:track-a:new-cluster:${index}`,
      createdAt: new Date(Date.parse("2026-08-03T12:00:00.000Z") - index).toISOString(),
      updatedAt: "2026-08-03T12:00:00.000Z",
      message: "New activity",
    }));
    const runs = Array.from({ length: 60 }, (_, index) => ({
      id: `run-${index}`,
      assetId: "asset-a",
      mode: "fixture" as const,
      generatedAt: new Date(Date.parse("2026-08-03T12:00:00.000Z") - index * 60_000).toISOString(),
      snapshot: snapshot("asset-a", "2026-08-03T12:00:00.000Z"),
      alerts,
      byteSize: 1_000,
      createdAt: "2026-08-03T12:00:00.000Z",
    }));

    const compact = compactSnapshotHistory(runs, "2026-08-02T12:00:00.000Z");

    expect(compact.runs).toHaveLength(48);
    expect(compact.alerts).toHaveLength(200);
    expect(compact.runs[0]).not.toHaveProperty("snapshot");
  });
});
