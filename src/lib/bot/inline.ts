// Inline search: users type "@bot query" in any chat and get hentaifox.com
// results. Tapping a result posts the gallery title + a button that opens
// the hentaifox gallery URL directly in the browser.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tg } from "./telegram";

const MAX_RESULTS = 30;
const CACHE_SECONDS = 60;
const SITE = "https://hentaifox.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max = 150): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export type Hit = { url: string; title: string; thumb: string | null };

async function fetchAndParse(url: string): Promise<Hit[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) return [];
  const html = await res.text();

  const map = new Map<string, Hit>();
  const re = /<a href="(\/gallery\/\d+\/)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1];
    const inner = m[2];
    const full = SITE + path;
    let hit = map.get(full);
    if (!hit) {
      hit = { url: full, title: "", thumb: null };
      map.set(full, hit);
    }
    const imgMatch = inner.match(/data-src="([^"]+)"/);
    if (imgMatch && !hit.thumb) {
      hit.thumb = imgMatch[1];
    } else if (!hit.title) {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      if (text) hit.title = decodeEntities(text);
    }
  }

  return Array.from(map.values()).filter((h) => h.title);
}

function slugify(q: string): string {
  return q
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export async function searchHentaifox(query: string, page: number): Promise<Hit[]> {
  if (!query) {
    return fetchAndParse(`${SITE}/${page > 1 ? `page/${page}/` : ""}`);
  }

  // 1. Free-text search first.
  const searchUrl = `${SITE}/search/?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;
  const hits = await fetchAndParse(searchUrl);
  if (hits.length > 0) return hits;

  // 2. Fallback: tag page (many single-word queries like "incest" have 0
  //    free-text results but a populated /tag/<slug>/ page).
  const slug = slugify(query);
  if (!slug) return [];
  const tagUrl = `${SITE}/tag/${encodeURIComponent(slug)}/${page > 1 ? `pag/${page}/` : ""}`;
  const tagHits = await fetchAndParse(tagUrl);
  if (tagHits.length > 0) return tagHits;

  // 3. Last-ditch: parody slug (some queries are parody names).
  const parodyUrl = `${SITE}/parody/${encodeURIComponent(slug)}/${page > 1 ? `pag/${page}/` : ""}`;
  return fetchAndParse(parodyUrl);
}

export async function handleInlineQuery(_db: SupabaseClient, inline: any): Promise<void> {
  const queryId: string = inline.id;
  const rawQuery: string = (inline.query ?? "").trim();
  const page = Math.max(1, Number.parseInt(inline.offset || "1", 10) || 1);

  let hits: Hit[] = [];
  try {
    hits = await searchHentaifox(rawQuery, page);
  } catch (e) {
    console.error("hentaifox fetch failed:", e);
  }

  const results = hits.slice(0, MAX_RESULTS).map((h, i) => {
    const title = h.title || "Untitled";
    const messageText =
      `<b>${escapeHtml(title)}</b>\n` +
      `<a href="${escapeHtml(h.url)}">${escapeHtml(h.url)}</a>`;

    const article: any = {
      type: "article",
      id: `hf-${page}-${i}`,
      title: truncate(title, 90),
      description: h.url.replace(/^https?:\/\//, ""),
      url: h.url,
      hide_url: true,
      input_message_content: {
        message_text: messageText,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: false, prefer_large_media: true },
      },
      reply_markup: {
        inline_keyboard: [[{ text: "🔗 Open on hentaifox", url: h.url }]],
      },
    };
    if (h.thumb) {
      article.thumbnail_url = h.thumb;
      article.thumbnail_width = 200;
      article.thumbnail_height = 280;
    }
    return article;
  });

  const nextOffset = results.length >= MAX_RESULTS ? String(page + 1) : "";

  await tg("answerInlineQuery", {
    inline_query_id: queryId,
    results,
    cache_time: CACHE_SECONDS,
    is_personal: false,
    next_offset: nextOffset,
  });
}
