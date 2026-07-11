// Interactive multi-select search inside the bot chat.
//
// Flow:
//   1. Admin sends /search <query>. Bot fetches hentaifox results and posts
//      a message with an inline keyboard: one row per result (checkbox +
//      title), plus "Send selected" / "Cancel" at the bottom. Session state
//      (hits + selected indexes) is stored in the search_sessions table
//      keyed by (chat_id, message_id).
//   2. Tapping a result row toggles its checkbox — the bot edits the same
//      message's keyboard.
//   3. Tapping "Send selected" edits the message into a plain list of
//      selected gallery URLs and attaches one "Copy" button per link
//      (using Telegram's copy_text button so the URL lands in the user's
//      clipboard for pasting into another bot).

import type { SupabaseClient } from "@supabase/supabase-js";
import { tg, sendMessage, editMessageText } from "./telegram";
import { searchHentaifox, type Hit } from "./inline";

const MAX_RESULTS = 20; // keep the keyboard readable
const TITLE_LIMIT = 55;

function truncate(s: string, max: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildKeyboard(hits: Hit[], selected: number[]): any {
  const sel = new Set(selected);
  const rows: any[] = hits.map((h, i) => [
    {
      text: `${sel.has(i) ? "☑" : "☐"} ${truncate(h.title || "Untitled", TITLE_LIMIT)}`,
      callback_data: `s:t:${i}`,
    },
  ]);
  rows.push([
    { text: `✅ Send (${selected.length})`, callback_data: "s:x" },
    { text: "❌ Cancel", callback_data: "s:c" },
  ]);
  return { inline_keyboard: rows };
}

function headerHtml(query: string, hits: Hit[]): string {
  const q = query ? `<b>Search:</b> ${escapeHtml(query)}` : "<b>Latest galleries</b>";
  return `${q}\n<i>${hits.length} result${hits.length === 1 ? "" : "s"} — tick the ones you want, then press Send.</i>`;
}

export async function handleSearchCommand(
  db: SupabaseClient,
  chatId: number,
  userId: number,
  query: string,
): Promise<string | null> {
  let hits: Hit[] = [];
  try {
    hits = await searchHentaifox(query, 1);
  } catch (e) {
    console.error("search fetch failed:", e);
    return "❌ Couldn't reach hentaifox. Try again.";
  }
  hits = hits.slice(0, MAX_RESULTS);
  if (hits.length === 0) return `😕 No results for <b>${escapeHtml(query || "latest")}</b>.`;

  const sent: any = await sendMessage(chatId, headerHtml(query, hits), {
    reply_markup: buildKeyboard(hits, []),
    link_preview_options: { is_disabled: true },
  });

  const { error } = await db.from("search_sessions").upsert({
    chat_id: chatId,
    message_id: sent.message_id,
    user_id: userId,
    query,
    hits: hits as any,
    selected: [],
  });
  if (error) {
    console.error("save search session failed:", error);
    return `⚠️ Search shown but I couldn't save the session: ${error.message}`;
  }
  return null;
}

export async function handleSearchCallback(db: SupabaseClient, cb: any): Promise<void> {
  const cbId: string = cb.id;
  const data: string = cb.data ?? "";
  const msg = cb.message;
  if (!msg || !data.startsWith("s:")) {
    await tg("answerCallbackQuery", { callback_query_id: cbId });
    return;
  }
  const chatId = msg.chat.id as number;
  const messageId = msg.message_id as number;
  const fromId = cb.from?.id as number | undefined;

  // Only the admin who started the session may control it.
  const { data: session } = await db
    .from("search_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .eq("message_id", messageId)
    .maybeSingle();

  if (!session) {
    await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text: "This search expired. Send /search again.",
      show_alert: false,
    });
    return;
  }
  if (fromId && Number(session.user_id) !== Number(fromId)) {
    await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text: "This search belongs to someone else.",
      show_alert: false,
    });
    return;
  }

  const hits: Hit[] = Array.isArray(session.hits) ? (session.hits as any) : [];
  let selected: number[] = Array.isArray(session.selected) ? (session.selected as any) : [];

  const parts = data.split(":");
  const action = parts[1];

  if (action === "t") {
    const idx = Number(parts[2]);
    if (!Number.isFinite(idx) || idx < 0 || idx >= hits.length) {
      await tg("answerCallbackQuery", { callback_query_id: cbId });
      return;
    }
    const set = new Set(selected);
    if (set.has(idx)) set.delete(idx);
    else set.add(idx);
    selected = Array.from(set).sort((a, b) => a - b);

    await db
      .from("search_sessions")
      .update({ selected })
      .eq("chat_id", chatId)
      .eq("message_id", messageId);

    try {
      await tg("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildKeyboard(hits, selected),
      });
    } catch (e) {
      console.error("editMessageReplyMarkup failed:", e);
    }
    await tg("answerCallbackQuery", { callback_query_id: cbId });
    return;
  }

  if (action === "c") {
    await db
      .from("search_sessions")
      .delete()
      .eq("chat_id", chatId)
      .eq("message_id", messageId);
    try {
      await editMessageText(chatId, messageId, "❌ <i>Search cancelled.</i>");
    } catch {
      /* ignore */
    }
    await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Cancelled" });
    return;
  }

  if (action === "x") {
    if (selected.length === 0) {
      await tg("answerCallbackQuery", {
        callback_query_id: cbId,
        text: "Pick at least one result first.",
        show_alert: false,
      });
      return;
    }

    const picked = selected.map((i) => hits[i]).filter(Boolean);
    const lines = picked.map(
      (h, i) => `${i + 1}. <b>${escapeHtml(truncate(h.title || "Untitled", 90))}</b>\n${escapeHtml(h.url)}`,
    );
    const body =
      `📤 <b>Selected galleries (${picked.length})</b>\n\n` +
      lines.join("\n\n") +
      `\n\n<i>Tap a Copy button below to copy that link — then paste it into the other bot.</i>`;

    // Telegram inline keyboards allow at most 8 rows nicely; group copy
    // buttons 2 per row. copy_text.text max is 256 chars, gallery URLs
    // are well under that.
    const copyRows: any[] = [];
    for (let i = 0; i < picked.length; i += 2) {
      const row: any[] = [];
      for (let j = i; j < Math.min(i + 2, picked.length); j++) {
        row.push({
          text: `📋 Copy #${j + 1}`,
          copy_text: { text: picked[j].url },
        });
      }
      copyRows.push(row);
    }
    // Also a single "Copy all" button when the joined text fits in 256 chars.
    const allText = picked.map((h) => h.url).join("\n");
    if (allText.length <= 256) {
      copyRows.push([{ text: `📋 Copy all (${picked.length})`, copy_text: { text: allText } }]);
    }

    try {
      await editMessageText(chatId, messageId, body, {
        reply_markup: { inline_keyboard: copyRows },
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      console.error("editMessageText (send) failed:", e);
      // Fallback: post as a new message.
      await sendMessage(chatId, body, {
        reply_markup: { inline_keyboard: copyRows },
        link_preview_options: { is_disabled: true },
      });
    }

    await db
      .from("search_sessions")
      .delete()
      .eq("chat_id", chatId)
      .eq("message_id", messageId);
    await tg("answerCallbackQuery", { callback_query_id: cbId, text: `Sent ${picked.length} link${picked.length === 1 ? "" : "s"}` });
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: cbId });
}
