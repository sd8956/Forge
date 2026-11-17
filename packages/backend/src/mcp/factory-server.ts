import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reportStepInputShape } from "@forge/shared";
import type { StepService } from "../steps/step-service.js";

/**
 * The `factory` MCP server as seen by one step session. The step id comes from
 * the URL of the per-step MCP config, so the agent never has to know it.
 */
export function createFactoryMcpServer(stepId: string, service: StepService, kind = ""): McpServer {
  const server = new McpServer({ name: "factory", version: "0.0.0" });
  // A definition stage reports with report_stage: the person reviews it before anything continues.
  const stage = kind.startsWith("def_");
  server.registerTool(
    stage ? "report_stage" : "report_step",
    {
      title: stage ? "Report the definition stage" : "Report step result",
      description: stage
        ? "Report the result of the current Forge definition stage. Call it exactly once, when the stage files are written " +
          "(done), you cannot continue without the person (blocked) or it could not be completed (failed). Forge checks the " +
          "files, closes the session and shows them to the person, who approves or asks for changes."
        : "Report the result of the current Forge pipeline step. Call it exactly once, when the step is finished " +
          "(done), cannot continue without outside input (blocked) or could not be completed (failed). " +
          "The session is closed right after a successful report.",
      inputSchema: reportStepInputShape,
    },
    async (input) => {
      const result = await service.report(stepId, input);
      return { content: [{ type: "text", text: result.message }], isError: !result.ok };
    },
  );
  return server;
}
