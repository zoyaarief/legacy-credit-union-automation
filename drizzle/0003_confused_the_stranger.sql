CREATE TABLE `invocation_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`window_start` text NOT NULL,
	`issued_count` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_invocation_rate_limits_owner_window` ON `invocation_rate_limits` (`owner_id`,`window_start`);--> statement-breakpoint
CREATE TABLE `operational_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`event_type` text NOT NULL,
	`outcome` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_operational_events_owner_created` ON `operational_events` (`owner_id`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
