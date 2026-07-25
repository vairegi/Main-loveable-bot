// Related-post keyboard: title-first matching (chapters / similar titles), hashtags as fallback.
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractHashtags } from "./engagement";

const STOP = new Set(["the", "and", "with", "for", "from", "into", "that", "this", "chapter", "part", "vol", "ch"]);

export function extractTitle(caption: string | null | undefined): string {
  if (!caption) return "";
  const first =
    caption
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#")) ?? "";
  return first.replace(/[<>*_`]/g, "").trim();
}

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    // drop chapter/volume markers and standalone numbers so "X 2" matches "X"
    .replace(/\b(chapter|chap|ch|part|pt|vol|volume|episode|ep)\b\.?\s*\d+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

function escLike(s: string): string {
  return s.replace(/[%,()]/g, " ").trim();
}

export async function findRelatedPosts(
  db: SupabaseClient,
  post: { id: number | string; caption: string | null },
  limit = 4,
): Promise<{ code: string; caption: string | null }[]> {
  const title = extractTitle(post.caption);
  const tokens = titleTokens(title);

  // 1) Title-first: find posts sharing the significant title words.
  if (tokens.length) {
    const probe = tokens.slice(0, 4);
    const orFilters = probe.map((t) => `caption.ilike.%${escLike(t)}%`).join(",");
    const { data } = await db
      .from("posts")
      .select("id, code, caption, posted_at")
      .not("posted_at", "is", null)
      .not("id", "eq", post.id)
      .or(orFilters)
      .order("posted_at", { ascending: false })
      .limit(60);

    const scored = (data ?? [])
      .map((r: any) => {
        const other = titleTokens(extractTitle(r.caption));
        if (!other.length) return null;
        const set = new Set(other);
        const hits = tokens.filter((t) => set.has(t)).length;
        const score = hits / Math.min(tokens.length, other.length);
        return score > 0 ? { r, score, hits } : null;
      })
      .filter(Boolean)
      .filter((x: any) => x.score >= 0.6 || x.hits >= 2)
      .sort((a: any, b: any) => b.score - a.score);

    if (scored.length) {
      return scored.slice(0, limit).map((x: any) => ({ code: x.r.code, caption: x.r.caption }));
    }
  }

  // 2) Fallback: hashtag overlap.
  const tags = extractHashtags(post.caption);
  if (!tags.length) return [];

  const orFilters = tags.slice(0, 3).map((t) => `caption.ilike.%#${escLike(t)}%`).join(",");
  const { data } = await db
    .from("posts")
    .select("id, code, caption, posted_at")
    .not("posted_at", "is", null)
    .not("id", "eq", post.id)
    .or(orFilters)
    .order("posted_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r: any) => ({ code: r.code, caption: r.caption }));
}


function shortTitle(caption: string | null | undefined, max = 24): string {
  if (!caption) return "View";
  const first = caption.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? caption;
  const clean = first.replace(/[<>]/g, "").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean || "View";
}

export function buildRelatedKeyboard(
  related: { code: string; caption: string | null }[],
  botUsername: string,
): any | null {
  if (!related.length) return null;
  const buttons = related.map((p) => ({
    text: `🔎 ${shortTitle(p.caption)}`,
    url: `https://t.me/${botUsername}?start=get_${p.code}`,
  }));
  // 2x2 grid
  const rows: any[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}
