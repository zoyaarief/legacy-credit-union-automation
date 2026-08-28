CREATE TABLE `approval_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_approval_decisions_request_decision` ON `approval_decisions` (`request_id`,`decision`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`submitted_by` text NOT NULL,
	`artifact_name` text NOT NULL,
	`artifact_version` text NOT NULL,
	`artifact_json` text NOT NULL,
	`risk_class` text NOT NULL,
	`required_approvals` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`reviewed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_approval_requests_state_created` ON `approval_requests` (`state`,`created_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `approval_requests` (`id`, `submitted_by`, `artifact_name`, `artifact_version`, `artifact_json`, `risk_class`, `required_approvals`, `state`, `created_at`, `updated_at`, `reviewed_at`)
SELECT `artifact_hash`, `owner_id`, `artifact_name`, `artifact_version`, `artifact_json`, 'read_only', 1, `state`, `created_at`, COALESCE(`reviewed_at`, `created_at`), `reviewed_at` FROM `artifact_reviews`;--> statement-breakpoint
INSERT OR IGNORE INTO `approval_decisions` (`id`, `request_id`, `reviewer_id`, `decision`, `created_at`)
SELECT `artifact_hash` || ':' || `owner_id`, `artifact_hash`, `owner_id`, 'approve', COALESCE(`reviewed_at`, `created_at`) FROM `artifact_reviews` WHERE `state` = 'approved';--> statement-breakpoint
PRAGMA optimize;
