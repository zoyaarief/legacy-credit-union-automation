CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`run_kind` text NOT NULL,
	`status` text NOT NULL,
	`artifact_name` text NOT NULL,
	`artifact_version` text NOT NULL,
	`provider` text,
	`summary_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`artifact_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_automation_runs_owner_created` ON `automation_runs` (`owner_id`,`created_at`);