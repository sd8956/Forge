CREATE TABLE `definition_stage` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`step_id` text,
	`feedback` text,
	`last_error` text,
	`approved_screens` text NOT NULL,
	`approved_at` integer,
	`commit` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `definition_stage_unique` ON `definition_stage` (`project_id`,`stage`);--> statement-breakpoint
CREATE TABLE `definition` (
	`project_id` text PRIMARY KEY NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`idea` text NOT NULL,
	`pr_url` text,
	`created_at` integer NOT NULL
);
