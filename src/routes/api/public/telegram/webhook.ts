import { createFileRoute } from "@tanstack/react-router";
import type { CmdCtx } from "@/lib/bot/commands";

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { deriveTelegramWebhookSecret, safeEqual } = await import("@/lib/bot/webhook-secret");
        const { getAdminDb } = await import("@/lib/bot/db");
        const { dispatchCommand } = await import("@/lib/bot/commands");
        const { sendMessage } = await import("@/lib/bot/telegram");


        const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
        if (!TELEGRAM_API_KEY) return new Response("Server misconfigured", { status: 500 });

        // Verify Telegram secret token
        const expected = deriveTelegramWebhookSecret(TELEGRAM_API_KEY);
        const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actual, expected)) return new Response("Unauthorized", { status: 401 });

        const update: any = await request.json();
        const db = getAdminDb();

        // Idempotency: skip duplicates
        if (typeof update.update_id === "number") {
          const { error: dupErr } = await db
            .from("telegram_updates")
            .insert({ update_id: update.update_id });
          if (dupErr && dupErr.code === "23505") {
            return Response.json({ ok: true, duplicate: true });
          }
        }

        // Handle new posts from database channels
        const channelPost = update.channel_post;
        if (channelPost?.chat?.id) {
          const { data: ch } = await db
            .from("channels")
            .select("role")
            .eq("telegram_chat_id", channelPost.chat.id)
            .maybeSingle();
          if (ch?.role === "database") {
            const { handleDatabaseChannelPost } = await import("@/lib/bot/posting");
            try {
              await handleDatabaseChannelPost(db, channelPost);
            } catch (e) {
              console.error("handleDatabaseChannelPost failed:", e);
            }
            return Response.json({ ok: true, database_post: true });
          }
          return Response.json({ ok: true, ignored_channel_post: true });
        }

        const message = update.message;
        if (!message?.text || !message.from) {
          return Response.json({ ok: true, ignored: true });
        }

        const text: string = message.text.trim();
        if (!text.startsWith("/")) {
          return Response.json({ ok: true, non_command: true });
        }

        // Parse "/cmd@BotName arg1 arg2"
        const [cmdRaw, ...args] = text.slice(1).split(/\s+/);
        const cmdName = cmdRaw.split("@")[0];

        const user = {
          id: message.from.id as number,
          username: message.from.username as string | undefined,
          first_name: message.from.first_name as string | undefined,
        };

        // Check admin status
        const { data: adminRow } = await db
          .from("admins")
          .select("is_super_admin")
          .eq("telegram_user_id", user.id)
          .maybeSingle();

        const { messageToHtml } = await import("@/lib/bot/entities");
        const rawHtml = messageToHtml(text, message.entities);

        const ctx: CmdCtx = {
          db,
          chatId: message.chat.id,
          user,
          args,
          rawText: text,
          rawHtml,
          isAdmin: !!adminRow,
          isSuperAdmin: !!adminRow?.is_super_admin,
        };

        try {
          const reply = await dispatchCommand(ctx, cmdName);
          if (reply) await sendMessage(ctx.chatId, reply);
        } catch (e: any) {
          console.error("Command error:", e);
          try {
            await sendMessage(ctx.chatId, `⚠️ Error: ${e?.message ?? "unknown"}`);
          } catch {
            /* ignore */
          }
        }

        return Response.json({ ok: true });
      },
    },
  },
});
