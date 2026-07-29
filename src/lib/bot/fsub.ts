// Force-subscribe: users must join configured channels (or send a
// chat_join_request for approval-only invite links) before receiving files.
import type { SupabaseClient } from "@supabase/supabase-js";
import { tg } from "./telegram";

export interface FsubChannel {
  chat_id: number;
  title?: string | null;
  invite_link?: string | null;
  username?: string | null;
}

export async function listForceSubChannels(db: SupabaseClient): Promise<FsubChannel[]> {
  const { data } = await db
    .from("channels")
    .select("telegram_chat_id, title, invite_link")
    .or("role.eq.forcesub,also_fsub.eq.true");
  return (data ?? []).map((c) => ({
    chat_id: Number(c.telegram_chat_id),
    title: c.title,
    invite_link: c.invite_link,
  }));
}

export async function addForceSubChannel(
  db: SupabaseClient,
  chatId: number,
  addedBy: number,
  inviteLink?: string | null,
) {
  return db.from("channels").upsert({
    telegram_chat_id: chatId,
    role: "forcesub",
    added_by: addedBy,
    invite_link: inviteLink ?? null,
  });
}


export async function removeForceSubChannel(db: SupabaseClient, chatId: number) {
  return db.from("channels").delete().eq("telegram_chat_id", chatId).eq("role", "forcesub");
}

export async function markJoinRequested(db: SupabaseClient, userId: number, chatId: number) {
  await db
    .from("fsub_satisfied")
    .upsert({ user_id: userId, channel_chat_id: chatId, satisfied_at: new Date().toISOString() });
}

async function isMember(chatId: number, userId: number): Promise<boolean> {
  try {
    const res: any = await tg("getChatMember", { chat_id: chatId, user_id: userId });
    const status = res?.status;
    return status === "creator" || status === "administrator" || status === "member" || status === "restricted";
  } catch {
    return false;
  }
}

// Fetches (and caches) the channel title. Uses stored channels.title first
// so repeat fsub checks avoid the getChat round-trip entirely.
async function resolveTitle(
  db: SupabaseClient,
  chatId: number,
  cached: string | null | undefined,
): Promise<string> {
  if (cached && cached.trim()) return cached;
  try {
    const chat: any = await tg("getChat", { chat_id: chatId });
    const title = chat?.title ?? String(chatId);
    if (chat?.title) {
      db.from("channels")
        .update({ title: chat.title })
        .eq("telegram_chat_id", chatId)
        .then(() => {}, () => {});
    }
    return title;
  } catch {
    return String(chatId);
  }
}


// Resolve title (using cached channels.title when present) and derive a join URL.
async function chatLink(
  db: SupabaseClient,
  chatId: number,
  storedLink: string | null | undefined,
  cachedTitle: string | null | undefined,
): Promise<{ url: string; title: string }> {
  const title = await resolveTitle(db, chatId, cachedTitle);
  if (storedLink) return { url: storedLink, title };
  return { url: `https://t.me/c/${String(chatId).replace(/^-100/, "")}`, title };
}

// Returns channels the user still needs to join (i.e. not a member AND
// no pending join-request satisfaction on record).
export async function unmetForceSubs(
  db: SupabaseClient,
  userId: number,
): Promise<{ chat_id: number; url: string; title: string }[]> {
  const [channels, satisfiedRes] = await Promise.all([
    listForceSubChannels(db),
    db.from("fsub_satisfied").select("channel_chat_id").eq("user_id", userId),
  ]);
  if (!channels.length) return [];

  const satSet = new Set((satisfiedRes.data ?? []).map((r) => Number(r.channel_chat_id)));
  const pending = channels.filter((c) => !satSet.has(c.chat_id));
  if (!pending.length) return [];

  // Parallel membership checks — biggest latency win when there are multiple fsub channels.
  const memberships = await Promise.all(pending.map((c) => isMember(c.chat_id, userId)));
  const stillUnmet = pending.filter((_, i) => !memberships[i]);
  if (!stillUnmet.length) return [];

  // Parallel link/title resolution (cached titles skip Telegram entirely).
  const links = await Promise.all(
    stillUnmet.map((c) => chatLink(db, c.chat_id, c.invite_link, c.title)),
  );
  return stillUnmet.map((c, i) => ({ chat_id: c.chat_id, ...links[i] }));
}


export function buildJoinKeyboard(
  unmet: { url: string; title: string }[],
  retryPayload: string,
  botUsername: string,
) {
  const inline_keyboard: any[][] = unmet.map((c) => [{ text: `📢 Join ${c.title}`, url: c.url }]);
  inline_keyboard.push([
    { text: "✅ I've Joined — Try Again", url: `https://t.me/${botUsername}?start=${retryPayload}` },
  ]);
  return { inline_keyboard };
}
