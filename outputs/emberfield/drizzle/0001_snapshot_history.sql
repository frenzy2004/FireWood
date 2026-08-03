CREATE TABLE `snapshot_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`mode` text NOT NULL,
	`generated_at` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`alerts_json` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_runs_asset_mode_generated_at` ON `snapshot_runs` (`asset_id`,`mode`,`generated_at`);