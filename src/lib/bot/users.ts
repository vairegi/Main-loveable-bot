// User tracking, ban list, and rate-limiting for the Get File flow.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BotUser {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  banned: boolean;
  banned_reason: string | null;
  rate_window_started_at: string | null;
  rate_window_count: number;
}

// Upsert a user + refresh last_seen. Cheap — one row.
export async function trackUser(
  db: SupabaseClient,
  user: { id: number; username?: string; first_name?: string },
): Promise<void> {
  await db.from("bot_users").upsert(
    {
      telegram_user_id: user.id,
      username: user.username ?? null,
      first_name: user.first_name ?? null,
      last_seen: new Date().toISOString(),
    },
    { onConflict: "telegram_user_id" },
  );
}

export async function getBotUser(db: SupabaseClient, userId: number): Promise<BotUser | null> {
  const { data } = await db
    .from("bot_users")
    .select("telegram_user_id, username, first_name, banned, banned_reason, rate_window_started_at, rate_window_count")
    .eq("telegram_user_id", userId)
    .maybeSingle();
  return (data as BotUser | null) ?? null;
}

// Rate-limit config: max N fetches per WINDOW_MS.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

export interface RateCheck {
  ok: boolean;
  retryAfterSeconds?: number;
}

// Returns ok=false if the user has exceeded MAX_PER_WINDOW in the last minute.
// Also increments the counter atomically-enough for our low-contention use.
export async function checkAndBumpRate(db: SupabaseClient, userId: number): Promise<RateCheck> {
  const now = Date.now();
  const { data } = await db
    .from("bot_users")
    .select("rate_window_started_at, rate_window_count")
    .eq("telegram_user_id", userId)
    .maybeSingle();

  const startedMs = data?.rate_window_started_at ? new Date(data.rate_window_started_at).getTime() : 0;
  const inWindow = startedMs && now - startedMs < WINDOW_MS;
  const nextCount = inWindow ? (data?.rate_window_count ?? 0) + 1 : 1;
  const nextStart = inWindow ? new Date(startedMs).toISOString() : new Date(now).toISOString();

  if (inWindow && nextCount > MAX_PER_WINDOW) {
    return { ok: false, retryAfterSeconds: Math.ceil((WINDOW_MS - (now - startedMs)) / 1000) };
  }

  await db
    .from("bot_users")
    .update({ rate_window_started_at: nextStart, rate_window_count: nextCount })
    .eq("telegram_user_id", userId);

  return { ok: true };
}

export async function banUser(
  db: SupabaseClient,
  targetId: number,
  reason: string | null,
): Promise<{ error?: string }> {
  const { error } = await db
    .from("bot_users")
    .upsert(
      {
        telegram_user_id: targetId,
        banned: true,
        banned_reason: reason,
        banned_at: new Date().toISOString(),
      },
      { onConflict: "telegram_user_id" },
    );
  return error ? { error: error.message } : {};
}

export async function unbanUser(db: SupabaseClient, targetId: number): Promise<{ error?: string }> {
  const { error } = await db
    .from("bot_users")
    .update({ banned: false, banned_reason: null, banned_at: null })
    .eq("telegram_user_id", targetId);
  return error ? { error: error.message } : {};
}
