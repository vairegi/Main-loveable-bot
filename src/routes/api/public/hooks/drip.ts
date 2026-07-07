// Drip scheduler endpoint — called by pg_cron every few minutes.
// Reads the schedule setting, decides whether a slot is due, and publishes N queued posts.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/drip")({
  server: {
    handlers: {
      POST: async () => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { computeDripBatch, dripQueue } = await import("@/lib/bot/posting");
        const db = getAdminDb();

        const batch = await computeDripBatch(db);
        if (batch <= 0) return Response.json({ ok: true, skipped: true });

        const result = await dripQueue(db, batch);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
