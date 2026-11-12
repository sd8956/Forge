import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reportStepInputShape } from "@forge/shared";
import type { StepService } from "../steps/step-service.js";

/**
 * The `factory` MCP server as seen by one step session. The step id comes from
 * the URL of the per-step MCP config, so the agent never has to know it.
 */
export function createFactoryMcpServer(stepId: string, service: StepService): McpServer {
  const server = new McpServer({ name: "factory", version: "0.0.0" });
  server.registerTool(
    "report_step",
    {
      title: "Report step result",
      description:
        "Report the result of the current Forge pipeline step. Call it exactly once, when the step is finished " +
        "(done), cannot continue without outside input (blocked) or could not be completed (failed). " +
        "The session is closed right after a successful report.",
      inputSchema: reportStepInputShape,
    },
    (input) => {
      const result = service.report(stepId, input);
      return { content: [{ type: "text", text: result.message }], isError: !result.ok };
    },
  );
  return server;
}
