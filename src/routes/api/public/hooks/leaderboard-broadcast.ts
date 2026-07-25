// Weekly automatic leaderboard broadcast.
//
// Builds the top-10 leaderboard text and queues it as a normal broadcast job,
// which the existing broadcast worker drains. Users are told how to check
// their own ranking with /leaderboard.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/leaderboard-broadcast")({
  server: {
    handlers: {
      POST: async () => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { leaderboard } = await import("@/lib/bot/discovery");
        const db = getAdminDb();

        // Don't stack on top of a running broadcast.
        const { data: existing } = await db
          .from("broadcast_jobs")
          .select("id")
          .in("status", ["pending", "running", "scheduled"])
          .limit(1)
          .maybeSingle();
        if (existing) return Response.json({ ok: true, skipped: "broadcast_busy" });

        const board = await leaderboard(db, 10);
        if (board.includes("No fetch activity")) {
          return Response.json({ ok: true, skipped: "no_activity" });
        }

        const text = [
          board,
          "",
          "👤 Want to see <b>your</b> position? Send /leaderboard — it shows the top 10 plus your own rank.",
        ].join("\n");

        // Report goes to the first super admin (fallback: any admin).
        const { data: admin } = await db
          .from("admins")
          .select("telegram_user_id")
          .order("is_super_admin", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!admin) return Response.json({ ok: false, error: "no_admin" });

        const initiator = Number(admin.telegram_user_id);
        const { data: job, error } = await db
          .from("broadcast_jobs")
          .insert({
            mode: "text",
            payload_text: text,
            initiator_chat_id: initiator,
            initiator_user_id: initiator,
            initiator_username: "auto-leaderboard",
          })
          .select("id")
          .single();

        if (error || !job) {
          return Response.json({ ok: false, error: error?.message ?? "insert_failed" }, { status: 500 });
        }

        return Response.json({ ok: true, job_id: job.id });
      },
    },
  },
});
