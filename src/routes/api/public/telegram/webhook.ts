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
        const { resetSettingsCache } = await import("@/lib/bot/settings");
        resetSettingsCache();



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

        // Callback buttons (destructive-command confirms, favorite/rate reactions).
        if (update.callback_query) {
          const data = String(update.callback_query.data ?? "");
          try {
            if (data.startsWith("cnf:")) {
              await import("@/lib/bot/commands");
              const { handleConfirmCallback } = await import("@/lib/bot/confirm");
              await handleConfirmCallback(db, update.callback_query);
            } else if (data.startsWith("fav:") || data.startsWith("rate:")) {
              const { handleReactionCallback } = await import("@/lib/bot/reactions");
              await handleReactionCallback(db, update.callback_query);
            } else if (data.startsWith("favsall:")) {
              const { handleFavsAllCallback } = await import("@/lib/bot/commands");
              await handleFavsAllCallback(db, update.callback_query);
            } else if (data.startsWith("sim:")) {
              const { handleSimilarCallback } = await import("@/lib/bot/commands");
              await handleSimilarCallback(db, update.callback_query);
            } else {
              const { tg } = await import("@/lib/bot/telegram");
              await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id });
            }
          } catch (e) {
            console.error("callback handler failed:", e);
          }
          return Response.json({ ok: true, callback: true });
        }




        // Handle join requests for forced-subscription channels (approval-required invite links).
        const joinReq = update.chat_join_request;
        if (joinReq?.chat?.id && joinReq?.from?.id) {
          try {
            const { markJoinRequested } = await import("@/lib/bot/fsub");
            await markJoinRequested(db, Number(joinReq.from.id), Number(joinReq.chat.id));
          } catch (e) {
            console.error("markJoinRequested failed:", e);
          }
          return Response.json({ ok: true, join_request: true });
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

        // Run independent reads in parallel: user tracking, admin lookup, and
        // entity-to-HTML conversion. Cuts ~150–300ms off every command reply.
        const [_track, adminRes, { messageToHtml }] = await Promise.all([
          (async () => {
            try {
              const { trackUser } = await import("@/lib/bot/users");
              await trackUser(db, user);
            } catch (e) {
              console.error("trackUser failed:", e);
            }
          })(),
          db
            .from("admins")
            .select("is_super_admin")
            .eq("telegram_user_id", user.id)
            .maybeSingle(),
          import("@/lib/bot/entities"),
        ]);

        const adminRow = adminRes.data;
        const rawHtml = messageToHtml(text, message.entities);


        const ctx: CmdCtx = {
          db,
          chatId: message.chat.id,
          user,
          args,
          rawText: text,
          rawHtml: rawHtml,
          isAdmin: !!adminRow,
          isSuperAdmin: !!adminRow?.is_super_admin,
          message,
          origin: new URL(request.url).origin,
        };



        try {
          const reply = await dispatchCommand(ctx, cmdName);
          if (reply) {
            const { getCommandAutodeleteSeconds, queueDeletion } = await import("@/lib/bot/autodelete");
            const cmdAutodel = await getCommandAutodeleteSeconds(db);
            const sentIds: number[] = [];
            // Telegram caps sendMessage text at 4096 chars. Split on newlines
            // so long replies (e.g. /help) don't 400 with "message is too long".
            const LIMIT = 3800;
            const chunks: string[] = [];
            if (reply.length <= LIMIT) {
              chunks.push(reply);
            } else {
              const lines = reply.split("\n");
              let buf = "";
              for (const ln of lines) {
                if (buf.length + ln.length + 1 > LIMIT) {
                  if (buf) chunks.push(buf);
                  buf = ln;
                } else {
                  buf = buf ? buf + "\n" + ln : ln;
                }
              }
              if (buf) chunks.push(buf);
            }
            for (const c of chunks) {
              const sent: any = await sendMessage(ctx.chatId, c);
              if (sent?.message_id) sentIds.push(sent.message_id);
            }
            if (cmdAutodel > 0) {
              const ids = [...sentIds];
              if (message?.message_id) ids.push(message.message_id);
              try {
                await queueDeletion(db, ctx.chatId, ids, cmdAutodel);
              } catch (e) {
                console.error("queueDeletion (command) failed:", e);
              }
            }
          }
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
