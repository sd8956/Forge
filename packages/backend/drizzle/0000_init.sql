CREATE TABLE `event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_entity_idx` ON `event` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `step` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`project_path` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`agent` text NOT NULL,
	`status` text NOT NULL,
	`model` text,
	`tmux_session` text NOT NULL,
	`claude_session_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`transcript_path` text,
	`input_path` text NOT NULL,
	`output_path` text NOT NULL,
	`timeout_ms` integer NOT NULL,
	`deadline_at` integer,
	`stop_block_count` integer DEFAULT 0 NOT NULL,
	`reported_at` integer,
	`summary` text,
	`artifacts` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`exit_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_claude_session_id_unique` ON `step` (`claude_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `step_live_unique` ON `step` (`project_path`,`task_id`,`kind`) WHERE status in ('queued', 'running', 'needs_human');--> statement-breakpoint
CREATE INDEX `step_status_idx` ON `step` (`status`);