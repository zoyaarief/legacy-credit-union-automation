CREATE TABLE `alert_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`alert_code` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_alert_outbox_status_next` ON `alert_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`assigned_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
PRAGMA optimize;
