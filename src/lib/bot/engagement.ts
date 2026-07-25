// Streaks, referrals, tag subscriptions, and personal stats.
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage } from "./telegram";

// ---------------- Streaks ----------------
export interface StreakRow {
  current_streak: number;
  longest_streak: number;
  last_fetch_day: string | null;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Bump streak on file_fetch. Returns the new row or null. */
export async function bumpStreak(db: SupabaseClient, userId: number): Promise<StreakRow | null> {
  const { data: cur } = await db
    .from("user_streaks")
    .select("current_streak, longest_streak, last_fetch_day")
    .eq("user_id", userId)
    .maybeSingle();

  const today = todayUTC();
  if (cur?.last_fetch_day === today) return cur as StreakRow;

  const yest = yesterdayUTC();
  let current = 1;
  if (cur?.last_fetch_day === yest) current = (cur.current_streak ?? 0) + 1;
  const longest = Math.max(cur?.longest_streak ?? 0, current);

  await db.from("user_streaks").upsert({
    user_id: userId,
    current_streak: current,
    longest_streak: longest,
    last_fetch_day: today,
    updated_at: new Date().toISOString(),
  });
  return { current_streak: current, longest_streak: longest, last_fetch_day: today };
}

export async function getStreak(db: SupabaseClient, userId: number): Promise<StreakRow | null> {
  const { data } = await db
    .from("user_streaks")
    .select("current_streak, longest_streak, last_fetch_day")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as StreakRow | null) ?? null;
}

// ---------------- Referrals ----------------
const REFERRAL_BONUS_FILES = 5;

/** Called when a user opens the bot via ?start=ref_<referrerId>. */
export async function registerReferral(
  db: SupabaseClient,
  referrerId: number,
  refereeId: number,
): Promise<{ granted: boolean; reason?: string }> {
  if (!referrerId || !refereeId || referrerId === refereeId) {
    return { granted: false, reason: "invalid" };
  }
  // Referee already tracked?
  const { data: existing } = await db
    .from("referrals")
    .select("referee_id")
    .eq("referee_id", refereeId)
    .maybeSingle();
  if (existing) return { granted: false, reason: "already_referred" };

  // Referrer must exist as a bot_user (i.e. real user)
  const { data: referrer } = await db
    .from("bot_users")
    .select("telegram_user_id")
    .eq("telegram_user_id", referrerId)
    .maybeSingle();
  if (!referrer) return { granted: false, reason: "no_referrer" };

  const { error } = await db.from("referrals").insert({
    referee_id: refereeId,
    referrer_id: referrerId,
  });
  if (error) return { granted: false, reason: error.message };

  // Grant bonus files to referrer
  const { data: cur } = await db
    .from("referral_bonuses")
    .select("bonus_files_remaining, total_earned")
    .eq("user_id", referrerId)
    .maybeSingle();
  await db.from("referral_bonuses").upsert({
    user_id: referrerId,
    bonus_files_remaining: (cur?.bonus_files_remaining ?? 0) + REFERRAL_BONUS_FILES,
    total_earned: (cur?.total_earned ?? 0) + REFERRAL_BONUS_FILES,
    updated_at: new Date().toISOString(),
  });

  // DM referrer
  try {
    await sendMessage(
      referrerId,
      `🎉 <b>New referral!</b> Someone joined via your link.\nYou earned <b>+${REFERRAL_BONUS_FILES}</b> bonus files (skip shortener).`,
    );
  } catch { /* ignore */ }

  return { granted: true };
}

export async function getReferralStats(db: SupabaseClient, userId: number) {
  const [count, bonus] = await Promise.all([
    db.from("referrals").select("referee_id", { count: "exact", head: true }).eq("referrer_id", userId),
    db.from("referral_bonuses").select("bonus_files_remaining, total_earned").eq("user_id", userId).maybeSingle(),
  ]);
  return {
    invited: count.count ?? 0,
    bonusRemaining: bonus.data?.bonus_files_remaining ?? 0,
    totalEarned: bonus.data?.total_earned ?? 0,
    perReferral: REFERRAL_BONUS_FILES,
  };
}

/** Consume one bonus file. Returns true if a bonus was used. */
export async function consumeBonusFile(db: SupabaseClient, userId: number): Promise<boolean> {
  const { data } = await db
    .from("referral_bonuses")
    .select("bonus_files_remaining")
    .eq("user_id", userId)
    .maybeSingle();
  const rem = data?.bonus_files_remaining ?? 0;
  if (rem <= 0) return false;
  await db
    .from("referral_bonuses")
    .update({ bonus_files_remaining: rem - 1, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  return true;
}

// ---------------- Tag subscriptions ----------------
export function normalizeTag(raw: string): string {
  let t = raw.trim().toLowerCase();
  if (t.startsWith("#")) t = t.slice(1);
  return t.replace(/[^a-z0-9_]/g, "");
}

export async function addTagSubscription(db: SupabaseClient, userId: number, tag: string): Promise<boolean> {
  const t = normalizeTag(tag);
  if (!t) return false;
  const { error } = await db.from("tag_subscriptions").upsert({ user_id: userId, tag: t });
  return !error;
}

export async function removeTagSubscription(db: SupabaseClient, userId: number, tag: string): Promise<boolean> {
  const t = normalizeTag(tag);
  if (!t) return false;
  const { error } = await db.from("tag_subscriptions").delete().eq("user_id", userId).eq("tag", t);
  return !error;
}

export async function listTagSubscriptions(db: SupabaseClient, userId: number): Promise<string[]> {
  const { data } = await db
    .from("tag_subscriptions")
    .select("tag")
    .eq("user_id", userId)
    .order("tag", { ascending: true });
  return (data ?? []).map((r: any) => r.tag as string);
}

/** Extract lowercase hashtag words from a caption (no '#'). */
export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const tags = new Set<string>();
  const re = /#([\p{L}0-9_]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[1].toLowerCase();
    if (t) tags.add(t);
  }
  return [...tags];
}

/** DM every subscriber of any tag in the post's caption. Best-effort, silent on error. */
export async function notifyTagSubscribers(
  db: SupabaseClient,
  post: { code: string; caption: string | null },
  botUsername: string,
): Promise<void> {
  const tags = extractHashtags(post.caption);
  if (!tags.length) return;
  const { data: subs } = await db
    .from("tag_subscriptions")
    .select("user_id, tag")
    .in("tag", tags);
  if (!subs?.length) return;
  // Dedup per user (in case they subscribe to multiple matching tags)
  const seen = new Map<number, string>();
  for (const s of subs) {
    if (!seen.has(s.user_id as number)) seen.set(s.user_id as number, s.tag as string);
  }
  const url = `https://t.me/${botUsername}?start=get_${post.code}`;
  await Promise.all(
    [...seen.entries()].map(async ([userId, tag]) => {
      try {
        await sendMessage(
          userId,
          `🔔 <b>New post for #${tag}</b>\n<a href="${url}">Tap to open</a>\n\nDisable with /unnotify ${tag}`,
          { disable_web_page_preview: true },
        );
      } catch { /* user may have blocked bot */ }
    }),
  );
}
