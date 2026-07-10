// Auto-delete tick — called every minute by pg_cron.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/autodelete")({
  server: {
    handlers: {
      POST: async () => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { processPendingDeletions } = await import("@/lib/bot/autodelete");
        const db = getAdminDb();
        const r = await processPendingDeletions(db);
        return Response.json({ ok: true, ...r });
      },
    },
  },
});
