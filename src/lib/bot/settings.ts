// Per-request cache for bot_settings reads.
//
// `bot_settings` is read many times per webhook invocation (caption templates,
// log channel, autodelete config, etc.). This cache avoids repeated round-trips
// to Postgres for the same key within a single webhook call.
//
// The Map is cleared at the top of every webhook POST via `resetSettingsCache()`.
// Workers are single-tick per request but instances can be reused across
// invocations, so we MUST clear on entry — otherwise stale values leak from
// the previous request.

import type { SupabaseClient } from "@supabase/supabase-js";

let cache = new Map<string, unknown>();

export function resetSettingsCache(): void {
  cache = new Map();
}

export async function getSetting<T = unknown>(
  db: SupabaseClient,
  key: string,
): Promise<T | null> {
  if (cache.has(key)) return cache.get(key) as T | null;
  const { data } = await db.from("bot_settings").select("value").eq("key", key).maybeSingle();
  const value = (data?.value ?? null) as T | null;
  cache.set(key, value);
  return value;
}

export async function getSettingText(db: SupabaseClient, key: string): Promise<string> {
  const v = await getSetting<{ text?: string }>(db, key);
  return (v?.text ?? "").trim();
}

// Invalidate a key after a write (e.g. /setcaption). Cheap; safe to call always.
export function invalidateSetting(key: string): void {
  cache.delete(key);
}
