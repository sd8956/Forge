CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`project_path` text NOT NULL,
	`task_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`status` text NOT NULL,
	`current_step` text NOT NULL,
	`attempts` text NOT NULL,
	`last_handled_step_id` text,
	`pr_number` integer,
	`pr_url` text,
	`exit_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_open_unique` ON `run` (`project_path`,`task_id`) WHERE status in ('queued', 'running', 'needs_human');--> statement-breakpoint
CREATE INDEX `run_status_idx` ON `run` (`status`);--> statement-breakpoint
ALTER TABLE `step` ADD `attempt` integer DEFAULT 1 NOT NULL;