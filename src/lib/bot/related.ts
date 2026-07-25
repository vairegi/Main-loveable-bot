// Related-post keyboard: 4 recent posts that share a hashtag with the current post.
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractHashtags } from "./engagement";

export async function findRelatedPosts(
  db: SupabaseClient,
  post: { id: number | string; caption: string | null },
  limit = 4,
): Promise<{ code: string; caption: string | null }[]> {
  const tags = extractHashtags(post.caption);
  if (!tags.length) return [];

  // Build ilike-any filter across tags
  const orFilters = tags.slice(0, 3).map((t) => `caption.ilike.%#${t}%`).join(",");
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
