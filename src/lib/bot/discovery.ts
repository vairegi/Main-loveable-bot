// Discovery commands: /random, /recent, /trending, /similar.
// All operate on posts that have already been published (posted_at is not null).
import type { SupabaseClient } from "@supabase/supabase-js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function line(botUsername: string, i: number, p: { code: string; caption: string | null; fetch_count?: number | null }, extra?: string): string {
  const title = esc((p.caption ?? "").split("\n")[0].slice(0, 80) || `(no caption)`);
  const link = `https://t.me/${botUsername}?start=get_${p.code}`;
  const meta = extra ? ` — ${extra}` : "";
  return `${i}. <a href="${link}">${title}</a>${meta}`;
}

export async function randomPost(db: SupabaseClient, botUsername: string): Promise<string> {
  const { count } = await db
    .from("posts")
    .select("*", { count: "exact", head: true })
    .not("posted_at", "is", null);
  const total = count ?? 0;
  if (!total) return "No posts have been published yet.";
  const offset = Math.floor(Math.random() * total);
  const { data } = await db
    .from("posts")
    .select("code, caption")
    .not("posted_at", "is", null)
    .order("id", { ascending: true })
    .range(offset, offset);
  const p = data?.[0];
  if (!p) return "No posts have been published yet.";
  return `🎲 <b>Random pick</b>\n\n${line(botUsername, 1, p)}`;
}

export async function recentPosts(db: SupabaseClient, botUsername: string, limit = 10): Promise<string> {
  const { data } = await db
    .from("posts")
    .select("code, caption, posted_at")
    .not("posted_at", "is", null)
    .order("posted_at", { ascending: false })
    .limit(limit);
  if (!data?.length) return "No posts have been published yet.";
  const lines = data.map((p, i) => line(botUsername, i + 1, p));
  return [`<b>🆕 Recent posts</b>`, "", ...lines].join("\n");
}

export async function trendingPosts(db: SupabaseClient, botUsername: string, limit = 10): Promise<string> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: logs } = await db
    .from("activity_log")
    .select("details")
    .eq("action", "file_fetch")
    .gte("created_at", since);
  const counts = new Map<string, number>();
  for (const r of logs ?? []) {
    const code = (r.details as any)?.code;
    if (typeof code === "string") counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!top.length) return "🔥 <b>Trending</b>\n\nNo fetches in the last 7 days yet — check back soon.";
  const codes = top.map(([c]) => c);
  const { data: posts } = await db
    .from("posts")
    .select("code, caption")
    .in("code", codes);
  const byCode = new Map((posts ?? []).map((p) => [p.code, p]));
  const lines = top
    .map(([code, n], i) => {
      const p = byCode.get(code);
      if (!p) return null;
      return line(botUsername, i + 1, p, `${n} fetch${n === 1 ? "" : "es"} · 7d`);
    })
    .filter(Boolean);
  return [`<b>🔥 Trending — last 7 days</b>`, "", ...lines].join("\n");
}

export function normalizeSimilarTag(rawTag: string): string {
  let tag = rawTag.trim().replace(/^\/similar(@\S+)?\s+/i, "");
  if (!tag) return "";
  if (!tag.startsWith("#")) tag = `#${tag}`;
  return tag;
}

export const SIMILAR_PAGE_SIZE = 15;

export async function similarPostsPage(
  db: SupabaseClient,
  botUsername: string,
  tag: string,
  page = 0,
  pageSize = SIMILAR_PAGE_SIZE,
): Promise<{ text: string; hasPrev: boolean; hasNext: boolean; total: number } | null> {
  const pattern = `%${tag.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const { count } = await db
    .from("posts")
    .select("*", { count: "exact", head: true })
    .not("posted_at", "is", null)
    .ilike("caption", pattern);
  const total = count ?? 0;
  if (!total) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const from = safePage * pageSize;
  const to = from + pageSize - 1;
  const { data } = await db
    .from("posts")
    .select("code, caption, fetch_count")
    .not("posted_at", "is", null)
    .ilike("caption", pattern)
    .order("fetch_count", { ascending: false })
    .range(from, to);
  const lines = (data ?? []).map((p, i) => line(botUsername, from + i + 1, p));
  const header = `<b>🔎 Similar to ${esc(tag)}</b> — ${total} match${total === 1 ? "" : "es"}`;
  const pageInfo = `<i>Page ${safePage + 1} / ${totalPages}</i>`;
  return {
    text: [header, pageInfo, "", ...lines].join("\n"),
    hasPrev: safePage > 0,
    hasNext: safePage < totalPages - 1,
    total,
  };
}

export async function similarPosts(db: SupabaseClient, botUsername: string, rawTag: string, limit = SIMILAR_PAGE_SIZE): Promise<string> {
  const tag = normalizeSimilarTag(rawTag);
  if (!tag) return "Usage: <code>/similar #tag</code> or <code>/similar tag</code>";
  const rendered = await similarPostsPage(db, botUsername, tag, 0, limit);
  if (!rendered) return `No posted files match <b>${esc(tag)}</b>.`;
  return rendered.text;
}

export async function leaderboard(
  db: SupabaseClient,
  limit = 10,
  viewerId?: number,
): Promise<string> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: logs } = await db
    .from("activity_log")
    .select("actor_id")
    .eq("action", "file_fetch")
    .gte("created_at", since);
  const counts = new Map<number, number>();
  for (const r of logs ?? []) {
    const id = Number(r.actor_id);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "🏆 <b>Leaderboard</b>\n\nNo fetch activity in the last 30 days yet.";
  const top = ranked.slice(0, limit);
  const ids = top.map(([id]) => id);
  if (viewerId && !ids.includes(viewerId)) ids.push(viewerId);
  const { data: users } = await db
    .from("bot_users")
    .select("telegram_user_id, first_name")
    .in("telegram_user_id", ids);
  const byId = new Map((users ?? []).map((u) => [Number(u.telegram_user_id), u]));
  const lines = top.map(([id, n], i) => {
    const u = byId.get(id);
    const name = esc(u?.first_name ?? "Anon");
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    return `${medal} ${name} — <b>${n}</b> fetch${n === 1 ? "" : "es"}`;
  });

  const out = [`<b>🏆 Leaderboard — last 30 days</b>`, "", ...lines];

  if (viewerId) {
    const idx = ranked.findIndex(([id]) => id === viewerId);
    const name = esc(byId.get(viewerId)?.first_name ?? "You");
    out.push("", "———————————");
    if (idx === -1) {
      out.push(`👤 <b>Your rank:</b> unranked — fetch a file to join the board!`);
    } else {
      const n = ranked[idx][1];
      out.push(
        `👤 <b>Your rank:</b> #${idx + 1} of ${ranked.length} — ${name}, <b>${n}</b> fetch${n === 1 ? "" : "es"}`,
      );
    }
  } else {
    out.push("", "———————————", "👤 Check your own ranking with /leaderboard");
  }

  return out.join("\n");
}

