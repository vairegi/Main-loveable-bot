// Auto-backup endpoint — called by pg_cron on a schedule.
// Runs one chunked backup pass for every registered backup channel and
// posts/edits a live progress message to every super-admin so users can
// watch percent-complete and pending counts in chat.
//
// Stuck detection: if a channel has pending posts but doneAll doesn't advance
// between runs, we mark it stuck, retry with exponential backoff (2m, 4m, 8m,
// 16m, 32m, cap 60m) and alert every super-admin once per stuck streak.
// Progress on the next attempt clears the streak automatically.

import { createFileRoute } from "@tanstack/react-router";

function bar(pct: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

// Backoff schedule in minutes, indexed by consecutive stuck attempts.
const BACKOFF_MIN = [2, 4, 8, 16, 32, 60];
// Alert admins after this many consecutive stuck attempts.
const ALERT_AFTER_ATTEMPTS = 2;

type StuckEntry = {
  lastDoneAll: number;
  lastProgressAt: string; // ISO
  stuckSince?: string; // ISO
  attempts: number; // consecutive no-progress attempts
  nextAttemptAt?: string; // ISO — skip channel until this time
  alertedAt?: string; // ISO — last time we alerted admins for this streak
};

type StuckMap = Record<string, StuckEntry>;

export const Route = createFileRoute("/api/public/hooks/auto-backup")({
  server: {
    handlers: {
      POST: async () => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { backupAllToChannel } = await import("@/lib/bot/backups");
        const { sendMessage, editMessageText } = await import("@/lib/bot/telegram");
        const db = getAdminDb();

        // Keep small: Cloudflare Workers wall-time ~30s, each post ~1–2s
        // (Telegram round-trip + 300ms delay). 8 fits comfortably.
        const BATCH = 8;
        const nowIso = new Date().toISOString();
        const nowMs = Date.now();

        const { data: channels } = await db
          .from("channels")
          .select("telegram_chat_id, title")
          .eq("role", "backup");

        // Load stuck-tracking state.
        const { data: stuckRow } = await db
          .from("bot_settings")
          .select("value")
          .eq("key", "auto_backup_stuck_state")
          .maybeSingle();
        const stuck: StuckMap = ((stuckRow?.value as any) ?? {}) as StuckMap;

        // Alerts collected this run, delivered once to every super-admin.
        const alerts: string[] = [];

        const results: Array<{
          chatId: number;
          title?: string | null;
          mirrored: number;
          failed: number;
          totalAll: number;
          doneAll: number;
          totalToDo: number;
          pending: number;
          pct: number;
          error?: string;
          skipped?: boolean;
          nextAttemptAt?: string;
          stuckAttempts?: number;
        }> = [];

        for (const c of channels ?? []) {
          const cid = Number(c.telegram_chat_id);
          if (!Number.isFinite(cid)) continue;
          const key = String(cid);
          const entry: StuckEntry = stuck[key] ?? {
            lastDoneAll: 0,
            lastProgressAt: nowIso,
            attempts: 0,
          };
          const label = c.title ? `${c.title} (${cid})` : String(cid);

          // Honor backoff — skip this channel until nextAttemptAt.
          if (entry.nextAttemptAt && new Date(entry.nextAttemptAt).getTime() > nowMs) {
            results.push({
              chatId: cid,
              title: c.title,
              mirrored: 0,
              failed: 0,
              totalAll: 0,
              doneAll: entry.lastDoneAll,
              totalToDo: 0,
              pending: 0,
              pct: 0,
              skipped: true,
              nextAttemptAt: entry.nextAttemptAt,
              stuckAttempts: entry.attempts,
            });
            continue;
          }

          try {
            const r = await backupAllToChannel(db, cid, BATCH);
            const pending = Math.max(0, r.totalAll - r.doneAll);
            const pct = r.totalAll > 0 ? Math.floor((r.doneAll / r.totalAll) * 100) : 100;

            // Auto-skipped posts (3 failed attempts) count as forward motion —
            // they no longer block the queue.
            const madeProgress = r.doneAll > entry.lastDoneAll || r.skippedIds.length > 0;
            if (madeProgress || pending === 0) {
              stuck[key] = {
                lastDoneAll: r.doneAll,
                lastProgressAt: nowIso,
                attempts: 0,
              };
            } else if (pending > 0) {
              const attempts = entry.attempts + 1;
              const stuckSince = entry.stuckSince ?? nowIso;
              const backoffMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
              const nextAttemptAt = new Date(nowMs + backoffMin * 60_000).toISOString();
              const shouldAlert =
                attempts >= ALERT_AFTER_ATTEMPTS &&
                (!entry.alertedAt || attempts === ALERT_AFTER_ATTEMPTS || attempts % 3 === 0);
              stuck[key] = {
                lastDoneAll: r.doneAll,
                lastProgressAt: entry.lastProgressAt,
                stuckSince,
                attempts,
                nextAttemptAt,
                alertedAt: shouldAlert ? nowIso : entry.alertedAt,
              };
              if (shouldAlert) {
                const stuckMinutes = Math.round((nowMs - new Date(stuckSince).getTime()) / 60_000);
                alerts.push(
                  `⚠️ <b>Backup stuck</b>\n📦 ${label}\n⏳ ${pending} pending, no progress for ${stuckMinutes}m (${attempts} attempts)${
                    r.firstError ? `\nlast error: <code>${r.firstError}</code>` : ""
                  }\n🔁 next retry in ${backoffMin}m`,
                );
              }
            }

            if (r.skippedIds.length > 0) {
              alerts.push(
                `⏭ <b>Auto-skipped ${r.skippedIds.length} un-mirrorable post${r.skippedIds.length === 1 ? "" : "s"}</b>\n📦 ${label}\nposts: <code>${r.skippedIds.join(", ")}</code>${
                  r.firstError ? `\nreason: <code>${r.firstError}</code>` : ""
                }\n\n<i>These posts kept failing after 3 attempts (Telegram refused to copy/forward them, e.g. service messages or protected content). They're marked processed so backup can continue.</i>`,
              );
            }


            results.push({
              chatId: cid,
              title: c.title,
              mirrored: r.mirrored,
              failed: r.failed,
              totalAll: r.totalAll,
              doneAll: r.doneAll,
              totalToDo: r.totalToDo,
              pending,
              pct,
              stuckAttempts: stuck[key]?.attempts ?? 0,
              nextAttemptAt: stuck[key]?.nextAttemptAt,
            });
          } catch (e: any) {
            // Treat a thrown error as a no-progress attempt so backoff kicks in.
            const attempts = entry.attempts + 1;
            const stuckSince = entry.stuckSince ?? nowIso;
            const backoffMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
            const nextAttemptAt = new Date(nowMs + backoffMin * 60_000).toISOString();
            const shouldAlert =
              attempts >= ALERT_AFTER_ATTEMPTS &&
              (!entry.alertedAt || attempts === ALERT_AFTER_ATTEMPTS || attempts % 3 === 0);
            stuck[key] = {
              lastDoneAll: entry.lastDoneAll,
              lastProgressAt: entry.lastProgressAt,
              stuckSince,
              attempts,
              nextAttemptAt,
              alertedAt: shouldAlert ? nowIso : entry.alertedAt,
            };
            if (shouldAlert) {
              alerts.push(
                `⚠️ <b>Backup error</b>\n📦 ${label}\n<code>${e?.message ?? "unknown"}</code>\n🔁 next retry in ${backoffMin}m (${attempts} attempts)`,
              );
            }
            results.push({
              chatId: cid,
              title: c.title,
              mirrored: 0,
              failed: 0,
              totalAll: 0,
              doneAll: entry.lastDoneAll,
              totalToDo: 0,
              pending: 0,
              pct: 0,
              error: e?.message ?? "unknown",
              stuckAttempts: attempts,
              nextAttemptAt,
            });
          }
        }

        // Persist stuck state.
        await db
          .from("bot_settings")
          .upsert({ key: "auto_backup_stuck_state", value: stuck }, { onConflict: "key" });

        // Compose the summary message.
        const nowLabel = nowIso.replace("T", " ").slice(0, 19);
        const lines: string[] = ["🤖 <b>Auto-backup status</b>"];
        if (!results.length) {
          lines.push("", "No backup channels registered.");
        } else {
          for (const r of results) {
            const label = r.title ? `${r.title} (<code>${r.chatId}</code>)` : `<code>${r.chatId}</code>`;
            if (r.error) {
              lines.push(
                "",
                `📦 ${label}`,
                `⚠️ error: ${r.error}`,
                r.nextAttemptAt ? `🔁 retry ${new Date(r.nextAttemptAt).toISOString().slice(11, 16)} UTC (attempt ${r.stuckAttempts})` : "",
              );
              continue;
            }
            if (r.skipped) {
              const wait = r.nextAttemptAt
                ? Math.max(0, Math.round((new Date(r.nextAttemptAt).getTime() - nowMs) / 60_000))
                : 0;
              lines.push(
                "",
                `📦 ${label}`,
                `⏸ backing off — retry in ${wait}m (attempt ${r.stuckAttempts})`,
              );
              continue;
            }
            const done = r.pending === 0 && r.totalAll > 0 ? " ✅" : "";
            const stuckTag = (r.stuckAttempts ?? 0) > 0 && r.pending > 0 ? ` ⚠️stuck×${r.stuckAttempts}` : "";
            lines.push(
              "",
              `📦 ${label}${done}${stuckTag}`,
              `${bar(r.pct)} ${r.pct}%`,
              `✔️ ${r.doneAll}/${r.totalAll}  ⏳ ${r.pending} pending  ${
                r.mirrored ? `➕${r.mirrored} this run` : "idle"
              }${r.failed ? `  ❌ ${r.failed} failed` : ""}`,
            );
          }
        }
        lines.push("", `<i>updated ${nowLabel} UTC</i>`);
        const text = lines.join("\n");

        // Super-admin recipients.
        const { data: sadmins } = await db
          .from("admins")
          .select("telegram_user_id")
          .eq("is_super_admin", true);

        // Live status message (edit in place).
        const { data: stateRow } = await db
          .from("bot_settings")
          .select("value")
          .eq("key", "auto_backup_status_msgs")
          .maybeSingle();
        const state = ((stateRow?.value as any) ?? {}) as Record<string, number>;
        let stateChanged = false;

        for (const a of sadmins ?? []) {
          const uid = Number(a.telegram_user_id);
          if (!Number.isFinite(uid)) continue;
          const existingMid = Number(state[String(uid)] ?? 0);
          let edited = false;
          if (existingMid > 0) {
            try {
              await editMessageText(uid, existingMid, text);
              edited = true;
            } catch (e: any) {
              if (/message is not modified/i.test(String(e?.message))) edited = true;
            }
          }
          if (!edited) {
            try {
              const m: any = await sendMessage(uid, text, { disable_notification: true });
              if (m?.message_id) {
                state[String(uid)] = m.message_id;
                stateChanged = true;
              }
            } catch (e) {
              console.error("auto-backup notify failed:", e);
            }
          }

          // Deliver stuck alerts as fresh notifying messages so they aren't
          // buried inside the edited status DM.
          for (const alert of alerts) {
            try {
              await sendMessage(uid, alert);
            } catch (e) {
              console.error("auto-backup alert failed:", e);
            }
          }
        }

        if (stateChanged) {
          await db
            .from("bot_settings")
            .upsert({ key: "auto_backup_status_msgs", value: state }, { onConflict: "key" });
        }

        return Response.json({ ok: true, channels: results, alerts: alerts.length });
      },
    },
  },
});
