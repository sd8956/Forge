import type { ReportStepInput } from "@forge/shared";
import type { StepRow } from "../db/schema.js";
import type { StepPolicy } from "./step-service.js";

/**
 * Sends each step to its owner: definition stages (`def_*`) to the definition
 * service, pipeline steps to the run service.
 */
export function routeStepPolicy(runs: StepPolicy, definition: Pick<StepPolicy, "validateReport" | "onStepChanged">): StepPolicy {
  const isStage = (step: StepRow) => step.kind.startsWith("def_");
  return {
    validateReport: (step: StepRow, input: ReportStepInput) => (isStage(step) ? definition.validateReport(step, input) : runs.validateReport(step, input)),
    // Stages have no exit command to run when the agent stops.
    stopCheck: (step: StepRow) => (isStage(step) ? Promise.resolve(null) : runs.stopCheck(step)),
    onStepChanged: (step: StepRow) => (isStage(step) ? definition.onStepChanged(step) : runs.onStepChanged(step)),
  };
}
