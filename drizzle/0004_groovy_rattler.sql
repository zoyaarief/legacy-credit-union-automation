CREATE TABLE `automation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`capability_name` text NOT NULL,
	`capability_version` text NOT NULL,
	`variant_id` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`input_ciphertext` text NOT NULL,
	`input_iv` text NOT NULL,
	`input_key_version` text NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`claimed_at` text,
	`lease_expires_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_automation_jobs_owner_status_created` ON `automation_jobs` (`owner_id`,`status`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
