import { auth, defineMcp } from "@lovable.dev/mcp-js";
import getBotStats from "./tools/get-bot-stats";
import listRecentPosts from "./tools/list-recent-posts";
import searchPosts from "./tools/search-posts";

// Direct Supabase issuer — mcp-js rejects the .lovable.cloud proxy per RFC 8414.
// VITE_SUPABASE_PROJECT_ID is inlined by Vite at build time.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "telegram-bot-admin-mcp",
  title: "Telegram Bot Admin",
  version: "0.1.0",
  instructions:
    "Read-only tools for inspecting the Telegram bot's database: overall stats, recent posts, and caption search. All tools require an admin account on this app.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [getBotStats, listRecentPosts, searchPosts],
});
