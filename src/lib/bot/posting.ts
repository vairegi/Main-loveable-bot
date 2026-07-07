// Posting engine — captures new channel posts into a QUEUE and drip-posts them
// to main channels on a configurable schedule.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import {
  copyMessage,
  editMessageCaption,
  getBotUsername,
  sendAudio,
  sendDocument,
  sendMessage,
  sendPhoto,
  sendVideo,
  deleteMessage,
} from "./telegram";

export interface TgMedia {
  kind: "photo" | "video" | "document" | "audio" | "text";
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  source_message_id?: number;
}

// Extract the primary media object from a Telegram message
export function extractMedia(msg: any): TgMedia {
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { kind: "photo", file_id: largest.file_id };
  }
  if (msg.video) return { kind: "video", file_id: msg.video.file_id, file_name: msg.video.file_name, mime_type: msg.video.mime_type };
  if (msg.document) return { kind: "document", file_id: msg.document.file_id, file_name: msg.document.file_name, mime_type: msg.document.mime_type };
  if (msg.audio) return { kind: "audio", file_id: msg.audio.file_id, file_name: msg.audio.file_name, mime_type: msg.audio.mime_type };
  return { kind: "text" };
}

// A "main" message starts a new post; a "file" message attaches to the previous main post.
// Rules based on the user's channel layout ("img + caption then files"):
//  - Photo               -> main
//  - Video with caption  -> main
//  - Video without cap.  -> file
//  - Document / Audio    -> file
//  - Text only           -> main (text post)
function classifyMessage(msg: any): "main" | "file" {
  if (msg.photo) return "main";
  if (msg.video) return (msg.caption ?? "").trim() ? "main" : "file";
  if (msg.document || msg.audio) return "file";
  if (msg.text) return "main";
  return "main";
}

function randomCode(): string {
  return randomBytes(6).toString("base64url");
}

async function getSetting<T = any>(db: SupabaseClient, key: string): Promise<T | null> {
  const { data } = await db.from("bot_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? null;
}

async function setSetting(db: SupabaseClient, key: string, value: unknown) {
  await db.from("bot_settings").upsert({ key, value, updated_at: new Date().toISOString() });
}

async function getCaptionTemplate(db: SupabaseClient): Promise<string> {
  const v = await getSetting<{ text: string }>(db, "caption_template");
  return v?.text ?? "{caption}\n\n🎬 Tap below to get the file.";
}

function renderCaption(template: string, ctx: { caption: string; code: string }): string {
  return template
    .replace(/\{caption\}/g, ctx.caption ?? "")
    .replace(/\{code\}/g, ctx.code)
    .trim();
}

function buildGetFileKeyboard(botUsername: string, code: string) {
  return {
    inline_keyboard: [[{ text: "📥 Get File", url: `https://t.me/${botUsername}?start=get_${code}` }]],
  };
}

// -------- Live capture from database channel_post updates --------
export async function handleDatabaseChannelPost(db: SupabaseClient, msg: any): Promise<void> {
  const sourceChatId = msg.chat.id as number;
  const sourceMessageId = msg.message_id as number;

  // Skip duplicates
  const { data: existing } = await db
    .from("posts")
    .select("id")
    .eq("source_chat_id", sourceChatId)
    .eq("source_message_id", sourceMessageId)
    .maybeSingle();
  if (existing) return;

  const kind = classifyMessage(msg);
  const media = extractMedia(msg);

  if (kind === "file") {
    // Attach to the most recent post from this same channel (within a 6-hour window)
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: parent } = await db
      .from("posts")
      .select("id, extra_files")
      .eq("source_chat_id", sourceChatId)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (parent) {
      const existingFiles = Array.isArray(parent.extra_files) ? parent.extra_files : [];
      await db
        .from("posts")
        .update({ extra_files: [...existingFiles, { ...media, source_message_id: sourceMessageId }] })
        .eq("id", parent.id);
      return;
    }
    // No parent within window — treat as a standalone queued post so it isn't lost
  }

  // Insert as a queued (posted_at = null) post
  const originalCaption = (msg.caption ?? msg.text ?? "") as string;
  const code = randomCode();
  await db.from("posts").insert({
    code,
    source_chat_id: sourceChatId,
    source_message_id: sourceMessageId,
    caption: originalCaption,
    media,
    media_group_id: msg.media_group_id ?? null,
    created_by: msg.from?.id ?? null,
    posted_at: null,
  });
}

// -------- Drip: publish the next N queued posts to all main channels --------
export async function dripQueue(db: SupabaseClient, batchSize: number): Promise<{ posted: number; failed: number; drained: boolean }> {
  const { data: queue } = await db
    .from("posts")
    .select("*")
    .is("posted_at", null)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (!queue?.length) return { posted: 0, failed: 0, drained: true };

  let posted = 0;
  let failed = 0;

  for (const post of queue) {
    try {
      await publishPost(db, post);
      await db.from("posts").update({ posted_at: new Date().toISOString() }).eq("id", post.id);
      posted++;
    } catch (e) {
      console.error("Drip publish failed:", post.id, e);
      failed++;
    }
  }
  return { posted, failed, drained: queue.length < batchSize };
}

async function publishPost(db: SupabaseClient, post: any): Promise<void> {
  const { data: mains } = await db.from("channels").select("telegram_chat_id").eq("role", "main");
  if (!mains?.length) throw new Error("No main channels registered");

  const botUsername = await getBotUsername();
  const template = await getCaptionTemplate(db);
  const captionText = renderCaption(template, { caption: post.caption ?? "", code: post.code });
  const keyboard = buildGetFileKeyboard(botUsername, post.code);
  const media = (post.media ?? {}) as TgMedia;

  for (const ch of mains) {
    // Send the "cover" (image/video/text) with the Get File button.
    // Prefer file_id (live-captured posts). Fall back to copyMessage from source
    // channel (backfilled posts have no Bot API file_id).
    let mainMessage: any;
    if (media.kind === "photo" && media.file_id) {
      mainMessage = await sendPhoto(ch.telegram_chat_id, media.file_id, { caption: captionText, reply_markup: keyboard });
    } else if (media.kind === "video" && media.file_id) {
      mainMessage = await sendVideo(ch.telegram_chat_id, media.file_id, { caption: captionText, reply_markup: keyboard });
    } else if (media.kind === "document" && media.file_id) {
      mainMessage = await sendDocument(ch.telegram_chat_id, media.file_id, { caption: captionText, reply_markup: keyboard });
    } else if (media.kind === "audio" && media.file_id) {
      mainMessage = await sendAudio(ch.telegram_chat_id, media.file_id, { caption: captionText, reply_markup: keyboard });
    } else if (media.kind !== "text" && post.source_chat_id && post.source_message_id) {
      // Backfill fallback — copy the original message from the database channel
      mainMessage = await copyMessage(ch.telegram_chat_id, post.source_chat_id, post.source_message_id, {
        caption: captionText,
        reply_markup: keyboard,
      });
    } else {
      mainMessage = await sendMessage(ch.telegram_chat_id, captionText, { reply_markup: keyboard });
    }

    await db.from("post_copies").insert({
      post_id: post.id,
      main_chat_id: ch.telegram_chat_id,
      main_message_id: mainMessage.message_id,
    });
  }
}

// -------- Deliver file to a user who clicked the deep-link --------
export async function deliverFileByCode(db: SupabaseClient, userChatId: number, code: string): Promise<string> {
  const { data: post } = await db.from("posts").select("*").eq("code", code).maybeSingle();
  if (!post) return "❌ Sorry, that file is no longer available.";

  const media = (post.media ?? {}) as TgMedia;
  const caption = post.caption ?? "";
  const extras = Array.isArray(post.extra_files) ? (post.extra_files as TgMedia[]) : [];

  try {
    // Cover
    if (media.kind === "photo" && media.file_id) await sendPhoto(userChatId, media.file_id, { caption });
    else if (media.kind === "video" && media.file_id) await sendVideo(userChatId, media.file_id, { caption });
    else if (media.kind === "document" && media.file_id) await sendDocument(userChatId, media.file_id, { caption });
    else if (media.kind === "audio" && media.file_id) await sendAudio(userChatId, media.file_id, { caption });
    else if (caption) await sendMessage(userChatId, caption);

    // Extra files (PDFs etc.)
    for (const f of extras) {
      if (!f.file_id) continue;
      if (f.kind === "document") await sendDocument(userChatId, f.file_id);
      else if (f.kind === "video") await sendVideo(userChatId, f.file_id);
      else if (f.kind === "audio") await sendAudio(userChatId, f.file_id);
      else if (f.kind === "photo") await sendPhoto(userChatId, f.file_id);
    }
    return "";
  } catch (e: any) {
    console.error("Deliver failed:", e);
    return `❌ Couldn't send you the file: ${e?.message ?? "unknown error"}`;
  }
}

// -------- Repost / delete helpers (admin commands) --------
export async function repostByCode(db: SupabaseClient, code: string): Promise<string> {
  const { data: post } = await db.from("posts").select("*").eq("code", code).maybeSingle();
  if (!post) return `❌ No post found with code <code>${code}</code>.`;
  try {
    await publishPost(db, post);
    await db.from("posts").update({ posted_at: new Date().toISOString() }).eq("id", post.id);
    return `✅ Reposted <code>${code}</code>.`;
  } catch (e: any) {
    return `❌ Repost failed: ${e?.message ?? "unknown"}`;
  }
}

export async function deletePostByCode(db: SupabaseClient, code: string): Promise<string> {
  const { data: post } = await db.from("posts").select("id").eq("code", code).maybeSingle();
  if (!post) return `❌ No post found with code <code>${code}</code>.`;

  const { data: copies } = await db.from("post_copies").select("*").eq("post_id", post.id);
  let deleted = 0;
  let failed = 0;
  for (const c of copies ?? []) {
    try {
      await deleteMessage(c.main_chat_id, c.main_message_id);
      deleted++;
    } catch {
      failed++;
    }
  }
  await db.from("posts").delete().eq("id", post.id);
  return `🗑️ Deleted post <code>${code}</code> — ${deleted} copies removed${failed ? `, ${failed} failed` : ""}.`;
}

// -------- Schedule types & helpers --------
export type Schedule =
  | { enabled: false }
  | { enabled: true; mode: "interval"; interval_minutes: number; batch_size: number; last_drip_at?: string | null }
  | { enabled: true; mode: "times"; times: string[]; per_slot: number; tz_offset_minutes: number; slots_done_for?: string /* YYYY-MM-DD */; done_slots?: string[] };

export async function getSchedule(db: SupabaseClient): Promise<Schedule> {
  const v = await getSetting<Schedule>(db, "schedule");
  return v ?? { enabled: false };
}

export async function saveSchedule(db: SupabaseClient, s: Schedule): Promise<void> {
  await setSetting(db, "schedule", s);
}

// Decide how many posts to drip right now and update bookkeeping.
export async function computeDripBatch(db: SupabaseClient): Promise<number> {
  const sched = await getSchedule(db);
  if (!sched.enabled) return 0;

  const now = new Date();

  if (sched.mode === "interval") {
    const last = sched.last_drip_at ? new Date(sched.last_drip_at) : null;
    const dueAt = last ? new Date(last.getTime() + sched.interval_minutes * 60_000) : now;
    if (now < dueAt) return 0;
    await saveSchedule(db, { ...sched, last_drip_at: now.toISOString() });
    return sched.batch_size;
  }

  if (sched.mode === "times") {
    const tzMin = sched.tz_offset_minutes ?? 0;
    const local = new Date(now.getTime() + tzMin * 60_000);
    const yyyy = local.getUTCFullYear();
    const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(local.getUTCDate()).padStart(2, "0");
    const dateKey = `${yyyy}-${mm}-${dd}`;
    const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();

    const doneSlots = sched.slots_done_for === dateKey ? (sched.done_slots ?? []) : [];

    // Find first slot whose scheduled minute is <= now and not yet marked done today
    for (const t of sched.times) {
      const [h, m] = t.split(":").map((x) => Number(x));
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      const slotMin = h * 60 + m;
      if (nowMinutes >= slotMin && !doneSlots.includes(t)) {
        await saveSchedule(db, {
          ...sched,
          slots_done_for: dateKey,
          done_slots: [...doneSlots, t],
        });
        return sched.per_slot;
      }
    }
    return 0;
  }

  return 0;
}

export async function queueSize(db: SupabaseClient): Promise<number> {
  const { count } = await db.from("posts").select("*", { count: "exact", head: true }).is("posted_at", null);
  return count ?? 0;
}
