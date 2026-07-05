import { defineMcp } from "@lovable.dev/mcp-js";
import echoTool from "./tools/echo";
import getTimeTool from "./tools/get-time";

export default defineMcp({
  name: "lovable-app-mcp",
  title: "Lovable App MCP",
  version: "0.1.0",
  instructions:
    "Tools exposed by this Lovable app. Use `echo` to verify connectivity and `get_current_time` to read the server clock.",
  tools: [echoTool, getTimeTool],
});
