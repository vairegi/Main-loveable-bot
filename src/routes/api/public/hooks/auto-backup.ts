// Auto-backup endpoint — called by pg_cron on a schedule.
// Runs one chunked backup pass for every registered backup channel and
// posts/edits a live progress message to every super-admin so users can
// watch percent-complete and pending counts in chat.

import { createFileRoute } from "@tanstack/react-router";

function bar(pct: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

export const Route = createFileRoute("/api/public/hooks/auto-backup")({
  server: {
    handlers: {
      POST: async () => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { backupAllToChannel } = await import("@/lib/bot/backups");
        const { sendMessage, editMessageText } = await import("@/lib/bot/telegram");
        const db = getAdminDb();

        // Cap per channel per invocation to stay inside the Worker time budget.
        const BATCH = 12;

        const { data: channels } = await db
          .from("channels")
          .select("telegram_chat_id, title")
          .eq("role", "backup");

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
        }> = [];

        for (const c of channels ?? []) {
          const cid = Number(c.telegram_chat_id);
          if (!Number.isFinite(cid)) continue;
          try {
            const r = await backupAllToChannel(db, cid, BATCH);
            const pending = Math.max(0, r.totalAll - r.doneAll);
            const pct = r.totalAll > 0 ? Math.floor((r.doneAll / r.totalAll) * 100) : 100;
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
            });
          } catch (e: any) {
            results.push({
              chatId: cid,
              title: c.title,
              mirrored: 0,
              failed: 0,
              totalAll: 0,
              doneAll: 0,
              totalToDo: 0,
              pending: 0,
              pct: 0,
              error: e?.message ?? "unknown",
            });
          }
        }

        // Compose one summary message covering every backup channel.
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        const lines: string[] = ["🤖 <b>Auto-backup status</b>"];
        if (!results.length) {
          lines.push("", "No backup channels registered.");
        } else {
          for (const r of results) {
            const label = r.title ? `${r.title} (<code>${r.chatId}</code>)` : `<code>${r.chatId}</code>`;
            if (r.error) {
              lines.push("", `📦 ${label}`, `⚠️ error: ${r.error}`);
              continue;
            }
            const done = r.pending === 0 && r.totalAll > 0 ? " ✅" : "";
            lines.push(
              "",
              `📦 ${label}${done}`,
              `${bar(r.pct)} ${r.pct}%`,
              `✔️ ${r.doneAll}/${r.totalAll}  ⏳ ${r.pending} pending  ${
                r.mirrored ? `➕${r.mirrored} this run` : "idle"
              }${r.failed ? `  ❌ ${r.failed} failed` : ""}`,
            );
          }
        }
        lines.push("", `<i>updated ${now} UTC</i>`);
        const text = lines.join("\n");

        // Post/edit a persistent status message per super-admin.
        const { data: sadmins } = await db
          .from("admins")
          .select("telegram_user_id")
          .eq("is_super_admin", true);

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
              // Telegram returns "message is not modified" when text unchanged
              // — treat as success so we don't spam a new message every cycle.
              if (/message is not modified/i.test(String(e?.message))) {
                edited = true;
              }
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
        }

        if (stateChanged) {
          await db
            .from("bot_settings")
            .upsert({ key: "auto_backup_status_msgs", value: state }, { onConflict: "key" });
        }

        return Response.json({ ok: true, channels: results });
      },
    },
  },
});
