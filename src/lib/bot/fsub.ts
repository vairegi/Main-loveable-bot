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
    .eq("role", "forcesub");
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

async function chatLink(chatId: number): Promise<{ url: string; title: string }> {
  try {
    const chat: any = await tg("getChat", { chat_id: chatId });
    const title = chat?.title ?? String(chatId);
    if (chat?.username) return { url: `https://t.me/${chat.username}`, title };
    if (chat?.invite_link) return { url: chat.invite_link, title };
    // Create an invite link with join request (requires the bot to be admin with invite rights).
    try {
      const inv: any = await tg("createChatInviteLink", { chat_id: chatId, creates_join_request: true });
      if (inv?.invite_link) return { url: inv.invite_link, title };
    } catch { /* ignore */ }
    return { url: `https://t.me/c/${String(chatId).replace(/^-100/, "")}`, title };
  } catch {
    return { url: `https://t.me/c/${String(chatId).replace(/^-100/, "")}`, title: String(chatId) };
  }
}

// Returns channels the user still needs to join (i.e. not a member AND
// no pending join-request satisfaction on record).
export async function unmetForceSubs(
  db: SupabaseClient,
  userId: number,
): Promise<{ chat_id: number; url: string; title: string }[]> {
  const channels = await listForceSubChannels(db);
  if (!channels.length) return [];

  const { data: satisfied } = await db
    .from("fsub_satisfied")
    .select("channel_chat_id")
    .eq("user_id", userId);
  const satSet = new Set((satisfied ?? []).map((r) => Number(r.channel_chat_id)));

  const unmet: { chat_id: number; url: string; title: string }[] = [];
  for (const c of channels) {
    if (satSet.has(c.chat_id)) continue;
    if (await isMember(c.chat_id, userId)) continue;
    const link = await chatLink(c.chat_id);
    unmet.push({ chat_id: c.chat_id, ...link });
  }
  return unmet;
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
