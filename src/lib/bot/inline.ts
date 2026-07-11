// Inline search: users type "@bot query" in any chat and get file matches.
// Tapping a result posts a short caption + "📥 Get File" deep-link button
// that opens the bot in DM with /start <code>, honoring fsub/verify/premium.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tg, getBotUsername } from "./telegram";

const MAX_RESULTS = 30;
const CACHE_SECONDS = 10;

function firstLine(s: string, max = 80): string {
  const line = (s || "").split("\n").find((l) => l.trim().length > 0) ?? "";
  const t = line.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function truncate(s: string, max = 150): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export async function handleInlineQuery(db: SupabaseClient, inline: any): Promise<void> {
  const queryId: string = inline.id;
  const rawQuery: string = (inline.query ?? "").trim();
  const offset = Number.parseInt(inline.offset || "0", 10) || 0;

  // Empty query: show newest posts so the picker isn't blank.
  const isEmpty = rawQuery.length === 0;

  let q = db
    .from("posts")
    .select("code, caption, created_at")
    .not("code", "is", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + MAX_RESULTS - 1);

  if (!isEmpty) {
    // Escape %/_ and split on whitespace — every token must appear in caption.
    const tokens = rawQuery.split(/\s+/).slice(0, 6);
    for (const t of tokens) {
      const safe = t.replace(/[\\%_]/g, (m) => "\\" + m);
      q = q.ilike("caption", `%${safe}%`);
    }
  }

  const { data: rows, error } = await q;
  if (error) {
    console.error("inline search failed:", error);
    await tg("answerInlineQuery", {
      inline_query_id: queryId,
      results: [],
      cache_time: 1,
      is_personal: true,
    });
    return;
  }

  const botUsername = await getBotUsername();

  const results = (rows ?? [])
    .filter((r: any) => r.code)
    .map((r: any, i: number) => {
      const caption = (r.caption ?? "").toString();
      const title = firstLine(caption) || `Post ${r.code}`;
      const desc = truncate(caption.replace(/^.*\n/, "").trim() || caption);
      const deepLink = `https://t.me/${botUsername}?start=${encodeURIComponent(r.code)}`;
      return {
        type: "article",
        id: `${r.code}-${i}`,
        title,
        description: desc,
        input_message_content: {
          message_text: `🎬 <b>${escapeHtml(title)}</b>\n\nTap the button below to get the file.`,
          parse_mode: "HTML",
        },
        reply_markup: {
          inline_keyboard: [[{ text: "📥 Get File", url: deepLink }]],
        },
      };
    });

  const nextOffset = results.length === MAX_RESULTS ? String(offset + MAX_RESULTS) : "";

  await tg("answerInlineQuery", {
    inline_query_id: queryId,
    results,
    cache_time: CACHE_SECONDS,
    is_personal: true,
    next_offset: nextOffset,
    button: isEmpty
      ? undefined
      : {
          text: results.length === 0 ? "No results — open bot" : "Open bot",
          start_parameter: "start",
        },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
