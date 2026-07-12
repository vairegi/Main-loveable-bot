// Favorite & rating callbacks (❤️ / 👍 / 👎) on delivered file messages.
//
// Callback data formats (kept short — Telegram caps callback_data at 64 bytes):
//   fav:t:<post_id>       toggle favorite
//   rate:<+1|-1>:<post_id>  set rating

import type { SupabaseClient } from "@supabase/supabase-js";
import { tg } from "./telegram";

export function buildReactionKeyboard(
  postId: number,
  botUsername: string,
  code: string,
  state: { faved: boolean; rating: 0 | 1 | -1; score: number },
): any {
  return {
    inline_keyboard: [[
      { text: state.faved ? "❤️ Saved" : "🤍 Save", callback_data: `fav:t:${postId}` },
      { text: state.rating === 1 ? "👍 ✓" : "👍", callback_data: `rate:1:${postId}` },
      { text: state.rating === -1 ? "👎 ✓" : "👎", callback_data: `rate:-1:${postId}` },
    ]],
  };
}

export async function getReactionState(
  db: SupabaseClient,
  postId: number,
  userId: number,
): Promise<{ faved: boolean; rating: 0 | 1 | -1; score: number }> {
  const [fav, mine, agg] = await Promise.all([
    db.from("favorites").select("post_id").eq("post_id", postId).eq("user_id", userId).maybeSingle(),
    db.from("post_ratings").select("rating").eq("post_id", postId).eq("user_id", userId).maybeSingle(),
    db.from("post_ratings").select("rating").eq("post_id", postId),
  ]);
  const score = (agg.data ?? []).reduce((s: number, r: any) => s + (r.rating ?? 0), 0);
  return {
    faved: !!fav.data,
    rating: (mine.data?.rating as 0 | 1 | -1) ?? 0,
    score,
  };
}

export async function handleReactionCallback(db: SupabaseClient, cb: any): Promise<void> {
  const data: string = cb.data ?? "";
  const cbId: string = cb.id;
  const userId = Number(cb.from?.id ?? 0);
  const msg = cb.message;

  try {
    if (data.startsWith("fav:t:")) {
      const postId = Number(data.slice("fav:t:".length));
      if (!postId || !userId) return void tg("answerCallbackQuery", { callback_query_id: cbId });

      const { data: existing } = await db
        .from("favorites")
        .select("post_id")
        .eq("post_id", postId)
        .eq("user_id", userId)
        .maybeSingle();

      if (existing) {
        await db.from("favorites").delete().eq("post_id", postId).eq("user_id", userId);
        await tg("answerCallbackQuery", { callback_query_id: cbId, text: "💔 Removed from favorites" });
      } else {
        await db.from("favorites").insert({ post_id: postId, user_id: userId });
        await tg("answerCallbackQuery", { callback_query_id: cbId, text: "❤️ Saved to favorites" });
      }
    } else if (data.startsWith("rate:")) {
      const parts = data.split(":");
      const rating = Number(parts[1]) as 1 | -1;
      const postId = Number(parts[2]);
      if (![1, -1].includes(rating) || !postId || !userId) {
        return void tg("answerCallbackQuery", { callback_query_id: cbId });
      }

      const { data: existing } = await db
        .from("post_ratings")
        .select("rating")
        .eq("post_id", postId)
        .eq("user_id", userId)
        .maybeSingle();

      if (existing?.rating === rating) {
        // Toggle off
        await db.from("post_ratings").delete().eq("post_id", postId).eq("user_id", userId);
        await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Removed" });
      } else {
        await db.from("post_ratings").upsert({ post_id: postId, user_id: userId, rating });
        await tg("answerCallbackQuery", {
          callback_query_id: cbId,
          text: rating === 1 ? "👍 Thanks!" : "👎 Noted",
        });
      }
    } else {
      await tg("answerCallbackQuery", { callback_query_id: cbId });
      return;
    }

    // Refresh the keyboard on the delivered message
    if (msg?.chat?.id && msg?.message_id) {
      const postId = Number(data.split(":").pop());
      if (postId) {
        const { data: post } = await db.from("posts").select("code").eq("id", postId).maybeSingle();
        const state = await getReactionState(db, postId, userId);
        const { getBotUsername } = await import("./telegram");
        const botUsername = await getBotUsername();
        const kb = buildReactionKeyboard(postId, botUsername, post?.code ?? "", state);
        try {
          await tg("editMessageReplyMarkup", {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            reply_markup: kb,
          });
        } catch { /* ignore edit failures (e.g. message too old) */ }
      }
    }
  } catch (e) {
    console.error("reaction callback failed:", e);
    try { await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Error" }); } catch { /* ignore */ }
  }
}
