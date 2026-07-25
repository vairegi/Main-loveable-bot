// Verification landing page.
//
// The shortener sends the user here after they solve. We record the visit
// server-side (timestamps used for bypass detection), then redirect them
// back to the bot with a signed deep-link payload.

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/v/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const token = String(params.token || "").trim();
        if (!token) return new Response("Missing token", { status: 400 });

        const { getAdminDb } = await import("@/lib/bot/db");
        const { markVerifyVisited } = await import("@/lib/bot/shortener");

        const db = getAdminDb();
        const result = await markVerifyVisited(db, token);
        if (!result.ok) {
          return new Response(
            "<h1>Link expired</h1><p>This verification link is no longer valid. Please request the file again in the bot.</p>",
            { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }

        const tg = `https://t.me/${result.botUsername}?start=verify_${encodeURIComponent(token)}`;
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Verified</title>
<meta http-equiv="refresh" content="0; url=${tg}">
<style>body{font-family:system-ui;padding:2rem;max-width:520px;margin:auto;text-align:center}</style>
<h1>✅ Verified</h1>
<p>Opening Telegram… If nothing happens, <a href="${tg}">tap here</a>.</p>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    },
  },
  component: () => null,
});
