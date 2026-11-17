CREATE TABLE `pr_thread` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`author` text,
	`path` text,
	`line` integer,
	`body` text NOT NULL,
	`url` text,
	`handled_by_step_id` text,
	`handled_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_thread_unique` ON `pr_thread` (`run_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `pr_thread_run_idx` ON `pr_thread` (`run_id`);--> statement-breakpoint
ALTER TABLE `run` ADD `mode` text DEFAULT 'build' NOT NULL;--> statement-breakpoint
ALTER TABLE `run` ADD `review_round` integer DEFAULT 0 NOT NULL;