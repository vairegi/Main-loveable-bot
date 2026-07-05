import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

export default defineTool({
  name: "get_current_time",
  title: "Get current time",
  description: "Return the current server time as an ISO 8601 timestamp, optionally in a specific IANA time zone.",
  inputSchema: {
    timeZone: z
      .string()
      .optional()
      .describe("Optional IANA time zone, e.g. 'America/New_York'. Defaults to UTC."),
  },
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  handler: ({ timeZone }) => {
    const now = new Date();
    let formatted: string;
    try {
      formatted = timeZone
        ? new Intl.DateTimeFormat("en-US", {
            timeZone,
            dateStyle: "full",
            timeStyle: "long",
          }).format(now)
        : now.toISOString();
    } catch {
      return {
        content: [{ type: "text", text: `Invalid time zone: ${timeZone}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: formatted }],
      structuredContent: { iso: now.toISOString(), timeZone: timeZone ?? "UTC" },
    };
  },
});
