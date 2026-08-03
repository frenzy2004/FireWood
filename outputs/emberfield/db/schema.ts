import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  radiusKm: real("radius_km").notNull(),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const detections = sqliteTable(
  "detections",
  {
    id: text("id").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    satellite: text("satellite").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    acquiredAt: text("acquired_at").notNull(),
    confidence: text("confidence").notNull(),
    frpMw: real("frp_mw"),
    rawJson: text("raw_json").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_detections_fingerprint").on(table.fingerprint),
    index("idx_detections_asset_acquired_at").on(table.assetId, table.acquiredAt),
  ],
);

export const clusters = sqliteTable("clusters", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  centroidLatitude: real("centroid_latitude").notNull(),
  centroidLongitude: real("centroid_longitude").notNull(),
  firstAcquiredAt: text("first_acquired_at").notNull(),
  latestAcquiredAt: text("latest_acquired_at").notNull(),
  detectionCount: integer("detection_count").notNull(),
  satellitesJson: text("satellites_json").notNull(),
  maxConfidence: text("max_confidence").notNull(),
  maxFrpMw: real("max_frp_mw"),
  memberFingerprintsJson: text("member_fingerprints_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const assessments = sqliteTable(
  "assessments",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id").notNull().references(() => clusters.id, { onDelete: "cascade" }),
    score: real("score"),
    scoreLow: real("score_low"),
    scoreHigh: real("score_high"),
    band: text("band").notNull(),
    dataConfidence: real("data_confidence").notNull(),
    dataQuality: text("data_quality").notNull(),
    reasonsJson: text("reasons_json").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (table) => [
    index("idx_assessments_asset_calculated_at").on(table.assetId, table.calculatedAt),
  ],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id").notNull().references(() => clusters.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    message: text("message").notNull(),
    acknowledged: integer("acknowledged", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("idx_alerts_dedupe_key").on(table.dedupeKey),
    index("idx_alerts_unacknowledged")
      .on(table.assetId, table.createdAt)
      .where(sql`${table.acknowledged} = 0`),
  ],
);

export const sourceSnapshots = sqliteTable("source_snapshots", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  observedAt: text("observed_at"),
  fetchedAt: text("fetched_at").notNull(),
  sourceUrl: text("source_url"),
  payloadJson: text("payload_json").notNull(),
});

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  answer: text("answer").notNull(),
  model: text("model").notNull(),
  traceJson: text("trace_json").notNull(),
  durationMs: integer("duration_ms").notNull(),
  createdAt: text("created_at").notNull(),
});
