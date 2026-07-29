// Backfill worker — called by pg_cron (and self-chained) to republish a range
// of stored posts into channels that missed them.
import { createFileRoute } from "@tanstack/react-router";

const CHUNK_SIZE = 5;

export const Route = createFileRoute("/api/public/hooks/backfill")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { runBackfillChunk, backfillStatusText } = await import("@/lib/bot/backfill");
        const { sendMessage, editMessageText } = await import("@/lib/bot/telegram");
        const db = getAdminDb();

        const res = await runBackfillChunk(db, CHUNK_SIZE);
        if (!res) return Response.json({ ok: true, idle: true });

        const { job, done, processed } = res;

        if (job.requesterChatId) {
          const text = done
            ? `✅ <b>Backfill complete</b>\nPosted: <b>${job.posted}</b> · Skipped: ${job.skipped} · Failed: ${job.failed}`
            : backfillStatusText(job);
          try {
            if (job.statusMessageId) {
              await editMessageText(job.requesterChatId, job.statusMessageId, text);
            } else {
              await sendMessage(job.requesterChatId, text);
            }
          } catch {
            /* ignore */
          }
        }

        if (!done && processed > 0) {
          try {
            const url = new URL(request.url);
            void fetch(url.toString(), { method: "POST" }).catch(() => {});
          } catch {
            /* ignore */
          }
        }

        return Response.json({ ok: true, done, processed, posted: job.posted, failed: job.failed });
      },
    },
  },
});
