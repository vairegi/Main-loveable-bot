// Auto-backup endpoint — called by pg_cron on a schedule.
// Runs one chunked backup pass for every registered backup channel so mirroring
// eventually completes with no manual /backup calls.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/auto-backup")({
  server: {
    handlers: {
      POST: async () => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { backupAllToChannel } = await import("@/lib/bot/backups");
        const db = getAdminDb();

        // Cap per channel per invocation to stay inside the Worker time/subrequest budget.
        const BATCH = 12;

        const { data: channels } = await db
          .from("channels")
          .select("telegram_chat_id")
          .eq("role", "backup");

        const results: any[] = [];
        for (const c of channels ?? []) {
          const cid = Number(c.telegram_chat_id);
          if (!Number.isFinite(cid)) continue;
          try {
            const r = await backupAllToChannel(db, cid, BATCH);
            results.push({ chatId: cid, ...r });
          } catch (e: any) {
            results.push({ chatId: cid, error: e?.message ?? "unknown" });
          }
        }

        return Response.json({ ok: true, channels: results });
      },
    },
  },
});
