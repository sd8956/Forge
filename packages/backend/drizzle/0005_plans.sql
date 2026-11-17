CREATE TABLE `execution_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`project_path` text NOT NULL,
	`status` text NOT NULL,
	`rationale` text NOT NULL,
	`proposed_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `execution_plan_project_idx` ON `execution_plan` (`project_path`,`status`);--> statement-breakpoint
CREATE TABLE `plan_task` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`project_path` text NOT NULL,
	`task_id` text NOT NULL,
	`wave` integer NOT NULL,
	`modules` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`depends_on` text NOT NULL,
	`state` text NOT NULL,
	`wait_reason` text,
	`run_id` text,
	`queued_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_task_unique` ON `plan_task` (`plan_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `plan_task_state_idx` ON `plan_task` (`state`);--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
