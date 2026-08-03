import { z } from "zod";

import type { Alert, AlertType, Asset } from "../domain/types";
import type { Snapshot, SnapshotSourceState } from "./snapshot";

export const ASSET_CATEGORIES = [
  "field",
  "orchard",
  "barn",
  "livestock",
  "workforce",
  "storage",
  "other",
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

const assetNameSchema = z.string().trim().min(1).max(100);
const assetNotesSchema = z.union([z.string().trim().max(2_000), z.null()]);

export const assetCreateSchema = z.object({
  name: assetNameSchema,
  category: z.enum(ASSET_CATEGORIES),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  radiusKm: z.number().finite().min(1).max(160.934),
  notes: assetNotesSchema.optional(),
}).strict();

export const assetUpdateSchema = assetCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one asset field is required",
  });

export type CreateAssetInput = z.input<typeof assetCreateSchema>;
export type UpdateAssetInput = z.input<typeof assetUpdateSchema>;

export interface SavedAsset extends Asset {
  category: AssetCategory;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAlert extends Alert {
  acknowledged: boolean;
}

export interface SaveAgentRunInput {
  assetId: string;
  prompt: string;
  answer: string;
  model: string;
  trace: unknown;
  durationMs: number;
}

export interface StoredAgentRun extends SaveAgentRunInput {
  id: string;
  createdAt: string;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface RepositoryDependencies {
  now?: () => Date;
  createId?: () => string;
}

type AssetRow = {
  id: string;
  name: string;
  category: AssetCategory;
  latitude: number;
  longitude: number;
  radius_km: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type AlertRow = {
  id: string;
  type: AlertType;
  asset_id: string;
  cluster_id: string;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
  message: string;
  acknowledged: number;
};

const agentRunSchema = z.object({
  assetId: z.string().trim().min(1).max(128),
  prompt: z.string().trim().min(1).max(12_000),
  answer: z.string().trim().min(1).max(30_000),
  model: z.string().trim().min(1).max(120),
  trace: z.unknown(),
  durationMs: z.number().int().min(0).max(600_000),
}).strict();

const utcIso = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid UTC timestamp");
  return date.toISOString();
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

const asSavedAsset = (row: AssetRow): SavedAsset => ({
  id: row.id,
  name: row.name,
  category: row.category,
  location: { lat: Number(row.latitude), lon: Number(row.longitude) },
  radiusKm: Number(row.radius_km),
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const asStoredAlert = (row: AlertRow): StoredAlert => ({
  id: row.id,
  type: row.type,
  assetId: row.asset_id,
  clusterId: row.cluster_id,
  dedupeKey: row.dedupe_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  message: row.message,
  acknowledged: Boolean(row.acknowledged),
});

const safeSourceUrl = (
  source: string,
  candidate: string | null,
): string | null => {
  if (!candidate) return null;
  const normalizedSource = source.trim().toUpperCase();
  if (normalizedSource.includes("FIRMS") || normalizedSource.includes("AIRNOW")) {
    return null;
  }
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    const isNws =
      normalizedSource.startsWith("NWS") && url.hostname === "api.weather.gov";
    const isWfigs =
      normalizedSource.startsWith("WFIGS") &&
      url.hostname === "services3.arcgis.com" &&
      url.pathname.startsWith(
        "/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_",
      );
    if (!isNws && !isWfigs) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

const normalizedSourceState = (state: SnapshotSourceState) => ({
  ...state,
  sourceUrl: safeSourceUrl(state.source, state.sourceUrl),
  sourceUrls: state.sourceUrls
    ?.map((sourceUrl) => safeSourceUrl(state.source, sourceUrl))
    .filter((sourceUrl): sourceUrl is string => sourceUrl !== null),
});

const detectionFingerprint = (
  detection: Snapshot["detections"][number],
): string => {
  const withFingerprint = detection as typeof detection & { fingerprint?: string };
  return withFingerprint.fingerprint ?? detection.id ?? [
    detection.source ?? "unknown",
    detection.satellite,
    utcIso(detection.acquiredAt),
    detection.lat,
    detection.lon,
  ].join("|");
};

export class RepositoryNotFoundError extends Error {}

export class AssetRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly database: D1DatabaseLike,
    dependencies: RepositoryDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? (() => crypto.randomUUID());
  }

  async listAssets(signal?: AbortSignal): Promise<SavedAsset[]> {
    throwIfAborted(signal);
    const { results } = await this.database
      .prepare(`SELECT id, name, category, latitude, longitude, radius_km, notes,
        created_at, updated_at
        FROM assets
        ORDER BY updated_at DESC, id ASC`)
      .all<AssetRow>();
    throwIfAborted(signal);
    return results.map(asSavedAsset);
  }

  private async findAsset(id: string): Promise<SavedAsset | null> {
    const row = await this.database
      .prepare(`SELECT id, name, category, latitude, longitude, radius_km, notes,
        created_at, updated_at
        FROM assets WHERE id = ?`)
      .bind(id)
      .first<AssetRow>();
    return row ? asSavedAsset(row) : null;
  }

  async createAsset(input: CreateAssetInput): Promise<SavedAsset> {
    const parsed = assetCreateSchema.parse(input);
    const timestamp = utcIso(this.now());
    const asset: SavedAsset = {
      id: this.createId(),
      name: parsed.name,
      category: parsed.category,
      location: { lat: parsed.latitude, lon: parsed.longitude },
      radiusKm: parsed.radiusKm,
      notes: parsed.notes?.trim() || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.database
      .prepare(`INSERT INTO assets (
        id, name, category, latitude, longitude, radius_km, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        asset.id,
        asset.name,
        asset.category,
        asset.location.lat,
        asset.location.lon,
        asset.radiusKm,
        asset.notes,
        asset.createdAt,
        asset.updatedAt,
      )
      .run();
    return asset;
  }

  async updateAsset(id: string, input: UpdateAssetInput): Promise<SavedAsset> {
    const parsed = assetUpdateSchema.parse(input);
    const existing = await this.findAsset(id);
    if (!existing) throw new RepositoryNotFoundError(`Asset ${id} was not found`);
    const updated: SavedAsset = {
      ...existing,
      name: parsed.name ?? existing.name,
      category: parsed.category ?? existing.category,
      location: {
        lat: parsed.latitude ?? existing.location.lat,
        lon: parsed.longitude ?? existing.location.lon,
      },
      radiusKm: parsed.radiusKm ?? existing.radiusKm,
      notes:
        parsed.notes === undefined
          ? existing.notes
          : parsed.notes?.trim() || null,
      updatedAt: utcIso(this.now()),
    };
    await this.database
      .prepare(`UPDATE assets SET
        name = ?, category = ?, latitude = ?, longitude = ?, radius_km = ?,
        notes = ?, updated_at = ?
        WHERE id = ?`)
      .bind(
        updated.name,
        updated.category,
        updated.location.lat,
        updated.location.lon,
        updated.radiusKm,
        updated.notes,
        updated.updatedAt,
        updated.id,
      )
      .run();
    return updated;
  }

  async saveSnapshot(
    snapshot: Snapshot,
    snapshotAlerts: Alert[] = [],
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const fetchedAt = utcIso(snapshot.generatedAt);
    const statements: D1PreparedStatementLike[] = [];

    for (const detection of snapshot.detections) {
      const fingerprint = detectionFingerprint(detection);
      statements.push(
        this.database
          .prepare(`INSERT INTO detections (
            id, fingerprint, asset_id, source, satellite, latitude, longitude,
            acquired_at, confidence, frp_mw, raw_json, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(fingerprint) DO UPDATE SET
            asset_id = excluded.asset_id, source = excluded.source,
            satellite = excluded.satellite, latitude = excluded.latitude,
            longitude = excluded.longitude, acquired_at = excluded.acquired_at,
            confidence = excluded.confidence, frp_mw = excluded.frp_mw,
            raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`)
          .bind(
            detection.id ?? this.createId(),
            fingerprint,
            snapshot.asset.id,
            detection.source ?? "unknown",
            detection.satellite,
            detection.lat,
            detection.lon,
            utcIso(detection.acquiredAt),
            detection.confidence,
            detection.frpMw,
            JSON.stringify(detection),
            fetchedAt,
          ),
      );
    }

    for (const group of snapshot.groups) {
      const { cluster, assessment } = group;
      statements.push(
        this.database
          .prepare(`INSERT INTO clusters (
            id, asset_id, centroid_latitude, centroid_longitude, first_acquired_at,
            latest_acquired_at, detection_count, satellites_json, max_confidence,
            max_frp_mw, member_fingerprints_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            centroid_latitude = excluded.centroid_latitude,
            centroid_longitude = excluded.centroid_longitude,
            first_acquired_at = excluded.first_acquired_at,
            latest_acquired_at = excluded.latest_acquired_at,
            detection_count = excluded.detection_count,
            satellites_json = excluded.satellites_json,
            max_confidence = excluded.max_confidence,
            max_frp_mw = excluded.max_frp_mw,
            member_fingerprints_json = excluded.member_fingerprints_json,
            updated_at = excluded.updated_at`)
          .bind(
            cluster.id,
            snapshot.asset.id,
            cluster.centroid.lat,
            cluster.centroid.lon,
            utcIso(cluster.firstAcquiredAt),
            utcIso(cluster.latestAcquiredAt),
            cluster.detectionCount,
            JSON.stringify(cluster.satellites),
            cluster.maxConfidence,
            cluster.maxFrpMw,
            JSON.stringify(cluster.memberFingerprints),
            fetchedAt,
          ),
      );
      statements.push(
        this.database
          .prepare(`INSERT INTO assessments (
            id, asset_id, cluster_id, score, score_low, score_high, band,
            data_confidence, data_quality, reasons_json, calculated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            this.createId(),
            snapshot.asset.id,
            cluster.id,
            assessment.score,
            assessment.scoreRange?.low ?? null,
            assessment.scoreRange?.high ?? null,
            assessment.band,
            assessment.dataConfidence,
            assessment.dataQuality,
            JSON.stringify(assessment.reasons),
            fetchedAt,
          ),
      );
    }

    for (const state of Object.values(snapshot.sources)) {
      const safeState = normalizedSourceState(state);
      statements.push(
        this.database
          .prepare(`INSERT INTO source_snapshots (
            id, asset_id, source, mode, status, observed_at, fetched_at,
            source_url, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            this.createId(),
            snapshot.asset.id,
            safeState.source,
            safeState.mode,
            safeState.status,
            safeState.observedAt ? utcIso(safeState.observedAt) : null,
            utcIso(safeState.fetchedAt),
            safeState.sourceUrl,
            JSON.stringify(safeState),
          ),
      );
    }

    for (const alert of snapshotAlerts) {
      statements.push(
        this.database
          .prepare(`INSERT INTO alerts (
            id, type, asset_id, cluster_id, dedupe_key, created_at, updated_at,
            message, acknowledged
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(dedupe_key) DO UPDATE SET
            type = excluded.type, updated_at = excluded.updated_at,
            message = excluded.message`)
          .bind(
            alert.id,
            alert.type,
            alert.assetId,
            alert.clusterId,
            alert.dedupeKey,
            utcIso(alert.createdAt),
            utcIso(alert.updatedAt),
            alert.message,
            0,
          ),
      );
    }

    throwIfAborted(signal);
    // D1 exposes no cancellation for an issued atomic batch. The final check
    // guarantees an aborted caller cannot begin a new write; an in-flight batch
    // may still finish atomically after its caller is aborted.
    await this.database.batch(statements);
  }

  async listAlerts(
    assetId: string,
    signal?: AbortSignal,
  ): Promise<StoredAlert[]> {
    throwIfAborted(signal);
    const { results } = await this.database
      .prepare(`SELECT id, type, asset_id, cluster_id, dedupe_key, created_at,
        updated_at, message, acknowledged
        FROM alerts
        WHERE asset_id = ? AND acknowledged = 0
        ORDER BY created_at DESC, id ASC`)
      .bind(assetId)
      .all<AlertRow>();
    throwIfAborted(signal);
    return results.map(asStoredAlert);
  }

  async saveAgentRun(
    input: SaveAgentRunInput,
    signal?: AbortSignal,
  ): Promise<StoredAgentRun> {
    throwIfAborted(signal);
    const parsed = agentRunSchema.parse(input);
    const run: StoredAgentRun = {
      ...parsed,
      id: this.createId(),
      createdAt: utcIso(this.now()),
    };
    const statement = this.database
      .prepare(`INSERT INTO agent_runs (
        id, asset_id, prompt, answer, model, trace_json, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        run.id,
        run.assetId,
        run.prompt,
        run.answer,
        run.model,
        JSON.stringify(run.trace ?? null),
        run.durationMs,
        run.createdAt,
      );
    throwIfAborted(signal);
    // Like D1 batches, an issued statement is atomic and cannot be cancelled.
    // No statement is issued after the deadline signal has already aborted.
    await statement.run();
    return run;
  }
}
