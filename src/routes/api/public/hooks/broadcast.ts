// Background broadcast worker.
//
// `/broadcast` inserts a row into `broadcast_jobs` and returns immediately.
// This endpoint chews through the pending job in small chunks and self-chains
// so a large user base (hundreds/thousands) doesn't block the Telegram webhook
// and doesn't starve other commands while it runs.

import { createFileRoute } from "@tanstack/react-router";

// Sends per invocation. We fire them in parallel (bounded by CONCURRENCY),
// so a chunk of 200 users finishes in ~7-10s wall time — well under Worker limits.
// Telegram allows ~30 msg/sec globally per bot; CONCURRENCY=25 stays safely below that.
const CHUNK_SIZE = 200;
const CONCURRENCY = 25;


export const Route = createFileRoute("/api/public/hooks/broadcast")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { sendMessage, forwardMessage } = await import("@/lib/bot/telegram");
        const db = getAdminDb();

        // Grab the oldest pending/running job.
        const { data: job } = await db
          .from("broadcast_jobs")
          .select("*")
          .in("status", ["pending", "running"])
          .order("id", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (!job) return Response.json({ ok: true, idle: true });

        // Fetch the next chunk of users past the cursor.
        const { data: users, error: usersErr } = await db
          .from("bot_users")
          .select("telegram_user_id, username, first_name")
          .eq("banned", false)
          .gt("telegram_user_id", job.cursor_user_id)
          .order("telegram_user_id", { ascending: true })
          .limit(CHUNK_SIZE);

        if (usersErr) {
          await db.from("broadcast_jobs").update({
            status: "error",
            finished_at: new Date().toISOString(),
          }).eq("id", job.id);
          return Response.json({ ok: false, error: usersErr.message });
        }

        if (!users || users.length === 0) {
          // No more users — finalise.
          await finaliseJob(db, job, sendMessage);
          return Response.json({ ok: true, finished: true });
        }

        const userList = users;
        let ok = 0;
        let failed = 0;
        const newBlocked: number[] = [];
        const newSamples: { id: number; username: string | null; first_name: string | null; reason: string; blocked: boolean }[] = [];
        const existingSampleCount = (job.failure_samples as any[])?.length ?? 0;


        // Parallel send with bounded concurrency.
        let cursor = 0;
        async function worker() {
          while (true) {
            const i = cursor++;
            if (i >= users.length) return;
            const u = users[i];
            const uid = Number(u.telegram_user_id);
            try {
              if (job.mode === "forward") {
                await forwardMessage(uid, job.source_chat_id!, Number(job.source_message_id!), {
                  disable_notification: false,
                });
              } else {
                await sendMessage(uid, job.payload_text ?? "");
              }
              ok++;
            } catch (e: any) {
              failed++;
              const err = String(e?.message ?? e ?? "unknown");
              const isBlocked = /\b403\b|bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(err);
              if (isBlocked) newBlocked.push(uid);
              if (existingSampleCount + newSamples.length < 30) {
                newSamples.push({
                  id: uid,
                  username: (u as any).username ?? null,
                  first_name: (u as any).first_name ?? null,
                  reason: err.slice(0, 200),
                  blocked: isBlocked,
                });
              }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker));


        // Auto-ban disabled: we just skip undeliverable users and keep going.
        // They remain in bot_users so future broadcasts can retry them.


        const mergedBlocked = [...(job.blocked_ids as number[] ?? []), ...newBlocked];
        const mergedSamples = [...(job.failure_samples as any[] ?? []), ...newSamples].slice(0, 30);
        const lastUserId = Number(users[users.length - 1].telegram_user_id);

        await db.from("broadcast_jobs").update({
          status: "running",
          cursor_user_id: lastUserId,
          total_ok: (job.total_ok ?? 0) + ok,
          total_failed: (job.total_failed ?? 0) + failed,
          blocked_ids: mergedBlocked,
          failure_samples: mergedSamples,
          last_tick_at: new Date().toISOString(),
        }).eq("id", job.id);

        // If this chunk was full, more users likely remain — self-chain.
        if (users.length === CHUNK_SIZE) {
          try {
            const url = new URL(request.url);
            void fetch(url.toString(), { method: "POST" }).catch(() => {});
          } catch { /* ignore */ }
        } else {
          // Last partial chunk — no more users, finalise now.
          const { data: refreshed } = await db.from("broadcast_jobs")
            .select("*").eq("id", job.id).maybeSingle();
          if (refreshed) await finaliseJob(db, refreshed, sendMessage);
        }

        return Response.json({ ok: true, chunk: users.length, delivered: ok, failed });
      },
    },
  },
});

async function finaliseJob(
  db: any,
  job: any,
  sendMessage: (chat: number | string, text: string, extra?: any) => Promise<any>,
) {
  if (job.status === "done") return;
  const finishedAt = new Date().toISOString();
  await db.from("broadcast_jobs").update({
    status: "done",
    finished_at: finishedAt,
  }).eq("id", job.id);

  const total = (job.total_ok ?? 0) + (job.total_failed ?? 0);
  const successRate = total ? (((job.total_ok ?? 0) / total) * 100).toFixed(1) : "0.0";
  const blockedCount = ((job.blocked_ids as any[]) ?? []).length;
  const otherFailed = (job.total_failed ?? 0) - blockedCount;
  const elapsedSec = job.started_at
    ? ((new Date(finishedAt).getTime() - new Date(job.started_at).getTime()) / 1000).toFixed(1)
    : "?";

  const summary = [
    `📢 <b>Broadcast delivery report</b>`,
    ``,
    `📨 Mode: <b>${job.mode === "forward" ? "Forward" : "Text"}</b>`,
    `👥 Reached: <b>${total}</b>`,
    `✅ Delivered: <b>${job.total_ok}</b> (${successRate}%)`,
    `❌ Failed: <b>${job.total_failed}</b>`,
    `  • 🚫 Blocked / unreachable: <b>${blockedCount}</b>`,
    `  • ⚠️ Other errors: <b>${otherFailed}</b>`,
    `⏱ Duration: <b>${elapsedSec}s</b>`,
  ].join("\n");

  try {
    await sendMessage(Number(job.initiator_chat_id), summary);
  } catch (e) {
    console.error("finaliseJob summary send failed:", e);
  }
}
