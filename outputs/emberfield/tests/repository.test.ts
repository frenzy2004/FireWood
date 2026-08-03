import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Alert } from "../lib/domain/types";
import type { Snapshot } from "../lib/server/snapshot";
import {
  AssetRepository,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "../lib/server/repository";

const workerEnvironment = vi.hoisted(() => ({ DB: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({ env: workerEnvironment }));

import { GET as listAssets, POST as createAsset } from "../app/api/assets/route";
import { PATCH as updateAsset } from "../app/api/assets/[id]/route";

type Row = Record<string, unknown>;

class FakeStatement implements D1PreparedStatementLike {
  values: unknown[] = [];

  constructor(
    readonly database: FakeD1Database,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    this.database.binds.push({ query: this.query, values });
    return this;
  }

  async run(): Promise<{ success: boolean }> {
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

class FakeD1Database implements D1DatabaseLike {
  readonly assets = new Map<string, Row>();
  readonly alerts = new Map<string, Row>();
  readonly preparedQueries: string[] = [];
  readonly binds: Array<{ query: string; values: unknown[] }> = [];
  batchCalls = 0;

  prepare(query: string): D1PreparedStatementLike {
    this.preparedQueries.push(query);
    return new FakeStatement(this, query);
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    this.batchCalls += 1;
    return Promise.all(statements.map((statement) => statement.run()));
  }

  run(query: string, values: unknown[]) {
    const sql = query.replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO assets")) {
      const [id, name, category, latitude, longitude, radiusKm, notes, createdAt, updatedAt] = values;
      this.assets.set(String(id), {
        id,
        name,
        category,
        latitude,
        longitude,
        radius_km: radiusKm,
        notes,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    } else if (sql.startsWith("UPDATE assets")) {
      const [name, category, latitude, longitude, radiusKm, notes, updatedAt, id] = values;
      const existing = this.assets.get(String(id));
      if (existing) {
        this.assets.set(String(id), {
          ...existing,
          name,
          category,
          latitude,
          longitude,
          radius_km: radiusKm,
          notes,
          updated_at: updatedAt,
        });
      }
    } else if (sql.startsWith("INSERT INTO alerts")) {
      const [id, type, assetId, clusterId, dedupeKey, createdAt, updatedAt, message, acknowledged] = values;
      this.alerts.set(String(dedupeKey), {
        id,
        type,
        asset_id: assetId,
        cluster_id: clusterId,
        dedupe_key: dedupeKey,
        created_at: createdAt,
        updated_at: updatedAt,
        message,
        acknowledged,
      });
    }
  }

  all(query: string, values: unknown[]): Row[] {
    const sql = query.replace(/\s+/g, " ").trim();
    if (sql.includes("FROM assets WHERE id = ?")) {
      const asset = this.assets.get(String(values[0]));
      return asset ? [asset] : [];
    }
    if (sql.includes("FROM assets")) return [...this.assets.values()];
    if (sql.includes("FROM alerts")) {
      return [...this.alerts.values()].filter(
        (alert) => alert.asset_id === values[0] && alert.acknowledged === 0,
      );
    }
    return [];
  }
}

const fixedNow = new Date("2026-08-03T12:00:00.000Z");

function createRepository(database = new FakeD1Database()) {
  let sequence = 0;
  return {
    database,
    repository: new AssetRepository(database, {
      now: () => fixedNow,
      createId: () => `generated-${++sequence}`,
    }),
  };
}

function snapshotFor(assetId: string): Snapshot {
  const detection = {
    id: "detection-1",
    source: "fixture:VIIRS_NOAA20_NRT",
    lat: 36.74,
    lon: -119.78,
    acquiredAt: "2026-08-03T11:30:00.000Z",
    satellite: "NOAA-20",
    confidence: "high" as const,
    frpMw: 24.5,
  };
  const cluster = {
    id: "cluster-1",
    centroid: { lat: 36.74, lon: -119.78 },
    detections: [detection],
    memberFingerprints: ["fingerprint-1"],
    detectionCount: 1,
    firstAcquiredAt: detection.acquiredAt,
    latestAcquiredAt: detection.acquiredAt,
    satellites: ["NOAA-20"],
    maxConfidence: "high" as const,
    maxFrpMw: 24.5,
  };
  const source = {
    mode: "fixture" as const,
    status: "ok" as const,
    source: "fixture",
    sourceUrl: null,
    fetchedAt: fixedNow.toISOString(),
    observedAt: detection.acquiredAt,
  };
  return {
    mode: "fixture",
    generatedAt: fixedNow.toISOString(),
    asset: {
      id: assetId,
      name: "Sierra Vista Almonds",
      location: { lat: 36.7378, lon: -119.7871 },
      radiusKm: 40.2,
    },
    bbox: {
      north: 37,
      south: 36,
      east: -119,
      west: -120,
      crossesAntimeridian: false,
    },
    detections: [detection],
    groups: [
      {
        cluster,
        weather: null,
        assessment: {
          assetId,
          clusterId: cluster.id,
          score: 74,
          scoreRange: { low: 68, high: 79 },
          band: "elevated-context",
          contributions: [],
          reasons: [{ code: "proximity", label: "Nearby", contribution: 30 }],
          missingInputs: [],
          completeness: "complete",
          dataQuality: "good",
          dataConfidence: 88,
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

describe("AssetRepository", () => {
  it("creates and lists saved agriculture assets", async () => {
    const { database, repository } = createRepository();
    const input = {
      name: "Sierra Vista Almonds",
      category: "orchard" as const,
      latitude: 36.7378,
      longitude: -119.7871,
      radiusKm: 40.2,
    };

    const created = await repository.createAsset(input);

    expect((await repository.listAssets())[0].id).toBe(created.id);
    expect(created).toMatchObject({
      name: input.name,
      category: input.category,
      radiusKm: input.radiusKm,
      location: { lat: input.latitude, lon: input.longitude },
      notes: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    });
    expect(created).not.toHaveProperty("latitude");
    expect(created).not.toHaveProperty("longitude");
    expect(database.preparedQueries.join("\n")).not.toContain(input.name);
    expect(database.binds.some(({ values }) => values.includes(input.name))).toBe(true);
  });

  it("updates only validated asset fields while retaining stored values", async () => {
    const { repository } = createRepository();
    const created = await repository.createAsset({
      name: "Sierra Vista Almonds",
      category: "orchard",
      latitude: 36.7378,
      longitude: -119.7871,
      radiusKm: 40.2,
    });

    const updated = await repository.updateAsset(created.id, {
      name: "Sierra Vista North",
      notes: "Check irrigation pumps",
    });

    expect(updated).toMatchObject({
      id: created.id,
      name: "Sierra Vista North",
      category: "orchard",
      radiusKm: 40.2,
      notes: "Check irrigation pumps",
    });
  });

  it("batches snapshot history and returns unacknowledged alerts", async () => {
    const { database, repository } = createRepository();
    const assetId = "asset-1";
    const alert: Alert = {
      id: "alert-1",
      type: "new-cluster",
      assetId,
      clusterId: "cluster-1",
      dedupeKey: `${assetId}:cluster-1:new-cluster`,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      message: "New activity",
    };

    await repository.saveSnapshot(snapshotFor(assetId), [alert]);

    expect(database.batchCalls).toBe(1);
    expect(database.preparedQueries.join("\n")).toMatch(/INSERT INTO detections/);
    expect(database.preparedQueries.join("\n")).toMatch(/INSERT INTO clusters/);
    expect(database.preparedQueries.join("\n")).toMatch(/INSERT INTO assessments/);
    expect(database.preparedQueries.join("\n")).toMatch(/INSERT INTO source_snapshots/);
    expect(await repository.listAlerts(assetId)).toEqual([
      expect.objectContaining({ id: alert.id, acknowledged: false }),
    ]);
    expect(database.preparedQueries.every((query) => !query.includes(";"))).toBe(true);
  });

  it("saves bounded agent-run values with generated UTC identity", async () => {
    const { database, repository } = createRepository();

    const run = await repository.saveAgentRun({
      assetId: "asset-1",
      prompt: "Summarize nearby fire activity",
      answer: "One elevated-context cluster is nearby.",
      model: "gemma4:12b",
      trace: { sources: ["FIRMS"] },
      durationMs: 842,
    });

    expect(run).toMatchObject({
      id: "generated-1",
      assetId: "asset-1",
      createdAt: fixedNow.toISOString(),
    });
    expect(database.preparedQueries.join("\n")).toMatch(/INSERT INTO agent_runs/);
  });

  it("rejects invalid asset categories and out-of-range radii", async () => {
    const { repository } = createRepository();

    await expect(
      repository.createAsset({
        name: "Invalid",
        category: "forest" as "other",
        latitude: 0,
        longitude: 0,
        radiusKm: 161,
      }),
    ).rejects.toBeDefined();
  });
});

describe("asset API validation", () => {
  let database: FakeD1Database;

  beforeEach(() => {
    database = new FakeD1Database();
    workerEnvironment.DB = database;
  });

  afterEach(() => {
    workerEnvironment.DB = undefined;
  });

  it("creates, lists, and updates a validated saved asset", async () => {
    const createResponse = await createAsset(
      new Request("http://localhost/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sierra Vista Almonds",
          category: "orchard",
          latitude: 36.7378,
          longitude: -119.7871,
          radiusKm: 40.2,
        }),
      }),
    );
    const created = (await createResponse.json()).asset;
    const listResponse = await listAssets();
    const listed = (await listResponse.json()).assets;
    const updateResponse = await updateAsset(
      new Request(`http://localhost/api/assets/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "Check irrigation pumps" }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );

    expect(createResponse.status).toBe(201);
    expect(listed).toHaveLength(1);
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).asset.notes).toBe("Check irrigation pumps");
  });

  it("returns 400 for an invalid asset payload", async () => {
    const response = await createAsset(
      new Request("http://localhost/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Too broad",
          category: "forest",
          latitude: 0,
          longitude: 0,
          radiusKm: 161,
        }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
