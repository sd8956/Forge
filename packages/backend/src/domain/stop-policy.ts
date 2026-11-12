import type { StepStatus } from "@forge/shared";

export interface StopContext {
  /** The agent already called report_step for this step. */
  reported: boolean;
  stepStatus: StepStatus;
  /** Claude Code sets this when it is already continuing because of a Stop hook. */
  stopHookActive: boolean;
  /** How many times this step's Stop hook has already blocked. */
  blockCount: number;
  maxBlocks: number;
  /** Background tasks still pending in the session; the turn is not really over. */
  backgroundTasks: number;
}

export type StopDecision =
  | { action: "block"; reason: string }
  | { action: "allow"; why: "reported" | "not_running" | "background_tasks" | "block_limit" };

/**
 * Safety net for steps that try to finish without calling report_step.
 * Bounded by maxBlocks so a step that refuses to report cannot loop forever
 * (stop_hook_active means we are already inside such a continuation).
 */
export function decideStop(ctx: StopContext): StopDecision {
  if (ctx.reported) return { action: "allow", why: "reported" };
  // needs_human still blocks: once the person answers a prompt the agent must report too.
  if (ctx.stepStatus !== "running" && ctx.stepStatus !== "needs_human") return { action: "allow", why: "not_running" };
  if (ctx.backgroundTasks > 0) return { action: "allow", why: "background_tasks" };
  if (ctx.blockCount >= ctx.maxBlocks) return { action: "allow", why: "block_limit" };

  const attempt = ctx.blockCount + 1;
  const prefix = ctx.stopHookActive ? "You still have not reported this step." : "You are stopping without reporting this step.";
  return {
    action: "block",
    reason:
      `${prefix} Call the report_step tool of the factory MCP server now ` +
      `(status done, blocked or failed, a summary and the list of artifacts), then stop. ` +
      `Reminder ${attempt}/${ctx.maxBlocks}.`,
  };
}
