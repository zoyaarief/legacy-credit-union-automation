CREATE TABLE `artifact_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`artifact_name` text NOT NULL,
	`artifact_version` text NOT NULL,
	`state` text NOT NULL,
	`artifact_json` text NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_artifact_reviews_owner_state` ON `artifact_reviews` (`owner_id`,`state`);--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `evidence_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `expires_at` text DEFAULT '' NOT NULL;