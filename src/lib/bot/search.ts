// Interactive multi-select search inside the bot chat.
//
// Flow:
//   1. Admin sends /search <query>. Bot fetches up to 3 pages of hentaifox
//      results (60 total) and posts a message with an inline keyboard:
//      10 result rows per page, Prev/Next navigation, plus
//      "Send selected" / "Cancel" at the bottom. Session state (hits,
//      selected indexes, current page) is stored in search_sessions.
//   2. Tapping a result row toggles its checkbox — the bot edits the same
//      message's keyboard.
//   3. Tapping "Send selected" edits the message into a plain list of
//      selected gallery URLs with copy_text buttons.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tg, sendMessage, editMessageText } from "./telegram";
import { searchHentaifox, type Hit } from "./inline";

const PAGES_TO_FETCH = 3;   // fetch up to 3 pages of hentaifox (~60 hits)
const PAGE_SIZE = 10;       // rows per keyboard page
const TITLE_LIMIT = 55;

function truncate(s: string, max: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pageCount(hits: Hit[]): number {
  return Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
}

function buildKeyboard(hits: Hit[], selected: number[], page: number): any {
  const sel = new Set(selected);
  const pages = pageCount(hits);
  const p = Math.min(Math.max(0, page), pages - 1);
  const start = p * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, hits.length);

  const rows: any[] = [];
  for (let i = start; i < end; i++) {
    rows.push([{
      text: `${sel.has(i) ? "☑" : "☐"} ${truncate(hits[i].title || "Untitled", TITLE_LIMIT)}`,
      callback_data: `s:t:${i}`,
    }]);
  }

  // Nav row (only if more than one page).
  if (pages > 1) {
    const nav: any[] = [];
    nav.push({
      text: p > 0 ? "⬅ Prev" : "·",
      callback_data: p > 0 ? `s:p:${p - 1}` : "s:noop",
    });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: "s:noop" });
    nav.push({
      text: p < pages - 1 ? "Next ➡" : "·",
      callback_data: p < pages - 1 ? `s:p:${p + 1}` : "s:noop",
    });
    rows.push(nav);
  }

  rows.push([
    { text: `✅ Send (${selected.length})`, callback_data: "s:x" },
    { text: "❌ Cancel", callback_data: "s:c" },
  ]);
  return { inline_keyboard: rows };
}

function headerHtml(query: string, hits: Hit[], selected: number[]): string {
  const q = query ? `<b>Search:</b> ${escapeHtml(query)}` : "<b>Latest galleries</b>";
  const selInfo = selected.length ? ` · <b>${selected.length}</b> selected` : "";
  return `${q}\n<i>${hits.length} result${hits.length === 1 ? "" : "s"} — tick the ones you want, then press Send.${selInfo}</i>`;
}

export async function handleSearchCommand(
  db: SupabaseClient,
  chatId: number,
  userId: number,
  query: string,
): Promise<string | null> {
  const collected: Hit[] = [];
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= PAGES_TO_FETCH; page++) {
      const pageHits = await searchHentaifox(query, page);
      if (!pageHits.length) break;
      for (const h of pageHits) {
        const key = h.url || h.title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push(h);
      }
      if (pageHits.length < 20) break; // last page reached
    }
  } catch (e) {
    console.error("search fetch failed:", e);
    return "❌ Couldn't reach hentaifox. Try again.";
  }

  if (collected.length === 0) return `😕 No results for <b>${escapeHtml(query || "latest")}</b>.`;

  const sent: any = await sendMessage(chatId, headerHtml(query, collected, []), {
    reply_markup: buildKeyboard(collected, [], 0),
    link_preview_options: { is_disabled: true },
  });

  const { error } = await db.from("search_sessions").upsert({
    chat_id: chatId,
    message_id: sent.message_id,
    user_id: userId,
    query,
    hits: collected as any,
    // We repurpose `selected` to also hold the current page as a sentinel
    // trailing entry — but keep the schema clean: store page in the query
    // string tail instead. Simpler: piggy-back on `selected` — no, use a
    // separate approach: store page as first element of a compact tuple in
    // hits? No — keep it clean and add a page column via updates: since we
    // can't add columns without a migration, we co-store the page as the
    // first element of `selected` with a sentinel wrapper. Instead: keep
    // page derivable from callback data (client-driven).
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

  // Derive the current page from the message keyboard so we don't need a
  // schema change. The keyboard's numeric badge like "3/6" gives us the page.
  let currentPage = 0;
  const kb = msg.reply_markup?.inline_keyboard;
  if (Array.isArray(kb)) {
    for (const row of kb) {
      for (const btn of row) {
        const m = /^(\d+)\/(\d+)$/.exec(btn.text ?? "");
        if (m) { currentPage = Number(m[1]) - 1; break; }
      }
    }
  }

  if (action === "noop") {
    await tg("answerCallbackQuery", { callback_query_id: cbId });
    return;
  }

  if (action === "p") {
    const target = Number(parts[2]);
    const pages = pageCount(hits);
    const p = Math.min(Math.max(0, target), pages - 1);
    try {
      await tg("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildKeyboard(hits, selected, p),
      });
    } catch (e) {
      console.error("editMessageReplyMarkup (page) failed:", e);
    }
    await tg("answerCallbackQuery", { callback_query_id: cbId });
    return;
  }

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
      await editMessageText(chatId, messageId, headerHtml(session.query ?? "", hits, selected), {
        reply_markup: buildKeyboard(hits, selected, currentPage),
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      // If text is identical (e.g. header unchanged), just refresh the keyboard.
      try {
        await tg("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildKeyboard(hits, selected, currentPage),
        });
      } catch (e2) {
        console.error("editMessageText / editMessageReplyMarkup failed:", e, e2);
      }
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
