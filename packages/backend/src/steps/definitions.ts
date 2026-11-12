/**
 * Pipeline steps known to the backend. Phase 0 only has `plan`; Phase 1 moves
 * these into the YAML pipeline definition.
 */
export interface StepDefinition {
  kind: string;
  /** Agent name in `.claude/agents/<agent>.md`. */
  agent: string;
  /** Settings template in `.factory/steps/`. */
  settingsFile: string;
  goal: string;
  /** Files the agent reads, relative to the worktree root. `{task}` is replaced by the task id. */
  inputs: string[];
  /** Files the agent writes inside the step's run directory. */
  outputs: { file: string; description: string }[];
  exitCriteria: string;
}

export const STEP_DEFINITIONS: Readonly<Record<string, StepDefinition>> = {
  plan: {
    kind: "plan",
    agent: "forge-planner",
    settingsFile: "planner.settings.json",
    goal: "Write the implementation plan and the test plan for the task.",
    inputs: [
      ".factory/backlog/{task}.md",
      ".factory/requirements.md",
      ".factory/architecture.md",
      ".factory/test-strategy.md",
    ],
    outputs: [
      { file: "plan.md", description: "Implementation plan: approach, files to touch, risks." },
      { file: "test-plan.md", description: "Test cases `TC-xx`, each linked to the FR ids it covers." },
      { file: "output.md", description: "Handoff for the next step: what was decided and where the artifacts are." },
    ],
    exitCriteria: "Every acceptance criterion of the task has at least one test case.",
  },
};

export function runDirFor(taskId: string, kind: string): string {
  return `.factory/runs/${taskId}/${kind}`;
}

export function renderInput(def: StepDefinition, ids: { stepId: string; taskId: string }): string {
  const runDir = runDirFor(ids.taskId, def.kind);
  const inputs = def.inputs.map((p) => `- \`${p.replaceAll("{task}", ids.taskId)}\``).join("\n");
  const outputs = def.outputs.map((o) => `- \`${runDir}/${o.file}\`: ${o.description}`).join("\n");
  return `# Step input: ${def.kind} — ${ids.taskId}

- Step id: \`${ids.stepId}\`
- Agent: \`${def.agent}\`
- All paths are relative to the worktree root (your working directory).

## Goal

${def.goal}

## Inputs

Read these files. Skip any that do not exist.

${inputs}

## Output contract

Write these files:

${outputs}

## Exit criteria

${def.exitCriteria}

## Finish

Follow the \`forge-step-protocol\` skill. The step only counts as finished when you call the
\`report_step\` tool of the \`factory\` MCP server with:

- \`status\`: \`done\`, \`blocked\` or \`failed\`
- \`summary\`: what you produced, or why you could not
- \`artifacts\`: the paths of the files you wrote, relative to the worktree root

Do not stop before calling \`report_step\`.
`;
}
