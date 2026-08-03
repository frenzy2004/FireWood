CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`prompt` text NOT NULL,
	`answer` text NOT NULL,
	`model` text NOT NULL,
	`trace_json` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`asset_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`message` text NOT NULL,
	`acknowledged` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alerts_dedupe_key` ON `alerts` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_alerts_unacknowledged` ON `alerts` (`asset_id`,`created_at`) WHERE "alerts"."acknowledged" = 0;--> statement-breakpoint
CREATE TABLE `assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`score` real,
	`score_low` real,
	`score_high` real,
	`band` text NOT NULL,
	`data_confidence` real NOT NULL,
	`data_quality` text NOT NULL,
	`reasons_json` text NOT NULL,
	`calculated_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_assessments_asset_calculated_at` ON `assessments` (`asset_id`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`radius_km` real NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`centroid_latitude` real NOT NULL,
	`centroid_longitude` real NOT NULL,
	`first_acquired_at` text NOT NULL,
	`latest_acquired_at` text NOT NULL,
	`detection_count` integer NOT NULL,
	`satellites_json` text NOT NULL,
	`max_confidence` text NOT NULL,
	`max_frp_mw` real,
	`member_fingerprints_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `detections` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`asset_id` text NOT NULL,
	`source` text NOT NULL,
	`satellite` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`acquired_at` text NOT NULL,
	`confidence` text NOT NULL,
	`frp_mw` real,
	`raw_json` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_detections_fingerprint` ON `detections` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_detections_asset_acquired_at` ON `detections` (`asset_id`,`acquired_at`);--> statement-breakpoint
CREATE TABLE `source_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`source` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`observed_at` text,
	`fetched_at` text NOT NULL,
	`source_url` text,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
