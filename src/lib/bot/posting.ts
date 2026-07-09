// Posting engine — captures new channel posts into a QUEUE and drip-posts them
// to main channels on a configurable schedule.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import {
  copyMessage,
  forwardMessage,
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

export interface DripFailure {
  id: number;
  code?: string;
  reason: string;
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

export async function getPostingOptions(db: SupabaseClient): Promise<{ protect: boolean; spoiler: boolean }> {
  const p = await getSetting<{ enabled: boolean }>(db, "protect_content");
  const s = await getSetting<{ enabled: boolean }>(db, "spoiler_media");
  return { protect: !!p?.enabled, spoiler: !!s?.enabled };
}

async function getCaptionTemplate(db: SupabaseClient): Promise<string> {
  const v = await getSetting<{ text: string }>(db, "caption_template");
  return v?.text ?? "{caption}\n\n🎬 Tap below to get the file.";
}

async function getExtraCaption(db: SupabaseClient, key: "post_caption_extra" | "file_caption_extra"): Promise<string> {
  const v = await getSetting<{ text: string }>(db, key);
  return (v?.text ?? "").trim();
}

function appendExtra(base: string, extra: string): string {
  if (!extra) return base;
  if (!base) return extra;
  return `${base}\n\n${extra}`;
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

function chatId(value: number | string): number | string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : value;
}

function numericMessageId(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function mediaWithSource(media: TgMedia, fallbackSourceMessageId?: number): TgMedia {
  return media.source_message_id || !fallbackSourceMessageId
    ? media
    : { ...media, source_message_id: fallbackSourceMessageId };
}

function dripFailureReason(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e ?? "unknown error");
  if (/chat not found/i.test(message)) {
    return "Telegram says chat not found. Make sure the bot is admin in both the database channel and the main channel, then run /dripnow again.";
  }
  if (/message to copy not found/i.test(message)) {
    return "Telegram cannot find the original database-channel message for this queued post.";
  }
  if (/not enough rights|administrator rights/i.test(message)) {
    return "Telegram says the bot needs admin posting rights in the channel.";
  }
  return message.slice(0, 220);
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
export async function dripQueue(db: SupabaseClient, batchSize: number): Promise<{ posted: number; failed: number; drained: boolean; failures: DripFailure[] }> {
  const { data: queue } = await db
    .from("posts")
    .select("*")
    .is("posted_at", null)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (!queue?.length) return { posted: 0, failed: 0, drained: true, failures: [] };

  let posted = 0;
  let failed = 0;
  const failures: DripFailure[] = [];

  for (const post of queue) {
    try {
      await publishPost(db, post);
      await db.from("posts").update({ posted_at: new Date().toISOString() }).eq("id", post.id);
      posted++;
    } catch (e) {
      console.error("Drip publish failed:", post.id, e);
      failed++;
      failures.push({ id: post.id, code: post.code, reason: dripFailureReason(e) });
    }
  }
  return { posted, failed, drained: queue.length < batchSize, failures };
}

async function publishPost(db: SupabaseClient, post: any): Promise<void> {
  const { data: mains } = await db.from("channels").select("telegram_chat_id").eq("role", "main");
  if (!mains?.length) throw new Error("No main channels registered");

  const botUsername = await getBotUsername();
  const template = await getCaptionTemplate(db);
  const captionText = appendExtra(
    renderCaption(template, { caption: post.caption ?? "", code: post.code }),
    await getExtraCaption(db, "post_caption_extra"),
  );
  const keyboard = buildGetFileKeyboard(botUsername, post.code);
  const sourceChatId = post.source_chat_id ? chatId(post.source_chat_id) : undefined;
  const sourceMessageId = numericMessageId(post.source_message_id);
  const media = mediaWithSource((post.media ?? {}) as TgMedia, sourceMessageId);
  const opts = await getPostingOptions(db);
  const protectExtra = opts.protect ? { protect_content: true } : {};
  const spoilerPhoto = opts.spoiler ? { has_spoiler: true } : {};

  // Spoiler needs sendPhoto/sendVideo (copyMessage doesn't support has_spoiler).
  // Backfilled posts have no file_id — hydrate one via forward+delete on the source channel.
  if (opts.spoiler && !media.file_id && (media.kind === "photo" || media.kind === "video") && sourceChatId && media.source_message_id) {
    try {
      const fwd: any = await forwardMessage(sourceChatId, sourceChatId, media.source_message_id);
      let fid: string | undefined;
      if (media.kind === "photo" && Array.isArray(fwd?.photo) && fwd.photo.length) {
        fid = fwd.photo[fwd.photo.length - 1].file_id;
      } else if (media.kind === "video" && fwd?.video?.file_id) {
        fid = fwd.video.file_id;
      }
      try { await deleteMessage(sourceChatId, fwd.message_id); } catch { /* ignore */ }
      if (fid) {
        media.file_id = fid;
        const newMedia = { ...(post.media ?? {}), file_id: fid };
        await db.from("posts").update({ media: newMedia }).eq("id", post.id);
      }
    } catch (e) {
      console.error("hydrateFileId failed:", e);
    }
  }


  for (const ch of mains) {
    const mainChatId = chatId(ch.telegram_chat_id);
    // Send the "cover" (image/video/text) with the Get File button.
    // Prefer file_id (live-captured posts). Fall back to copyMessage from source
    // channel (backfilled posts have no Bot API file_id).
    let mainMessage: any;
    const base = { caption: captionText, reply_markup: keyboard, ...protectExtra };
    if (media.kind === "photo" && media.file_id) {
      mainMessage = await sendPhoto(mainChatId, media.file_id, { ...base, ...spoilerPhoto });
    } else if (media.kind === "video" && media.file_id) {
      mainMessage = await sendVideo(mainChatId, media.file_id, { ...base, ...spoilerPhoto });
    } else if (media.kind === "document" && media.file_id) {
      mainMessage = await sendDocument(mainChatId, media.file_id, base);
    } else if (media.kind === "audio" && media.file_id) {
      mainMessage = await sendAudio(mainChatId, media.file_id, base);
    } else if (media.kind !== "text" && sourceChatId && media.source_message_id) {
      // Backfill fallback — copy the original message from the database channel
      mainMessage = await copyMessage(mainChatId, sourceChatId, media.source_message_id, base);
    } else {
      mainMessage = await sendMessage(mainChatId, captionText, { reply_markup: keyboard, ...protectExtra });
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

  const sourceChatId = post.source_chat_id ? chatId(post.source_chat_id) : undefined;
  const sourceMessageId = numericMessageId(post.source_message_id);
  const media = mediaWithSource((post.media ?? {}) as TgMedia, sourceMessageId);
  const caption = post.caption ?? "";
  const extras = Array.isArray(post.extra_files) ? (post.extra_files as TgMedia[]) : [];
  const opts = await getPostingOptions(db);
  const protectExtra = opts.protect ? { protect_content: true } : {};
  const spoilerPhoto = opts.spoiler ? { has_spoiler: true } : {};

  try {
    // Cover — prefer file_id, fall back to copyMessage from source channel
    if (media.kind === "photo" && media.file_id) await sendPhoto(userChatId, media.file_id, { caption, ...protectExtra, ...spoilerPhoto });
    else if (media.kind === "video" && media.file_id) await sendVideo(userChatId, media.file_id, { caption, ...protectExtra, ...spoilerPhoto });
    else if (media.kind === "document" && media.file_id) await sendDocument(userChatId, media.file_id, { caption, ...protectExtra });
    else if (media.kind === "audio" && media.file_id) await sendAudio(userChatId, media.file_id, { caption, ...protectExtra });
    else if (media.kind !== "text" && sourceChatId && media.source_message_id) {
      await copyMessage(userChatId, sourceChatId, media.source_message_id, { caption, ...protectExtra });
    } else if (caption) await sendMessage(userChatId, caption, { ...protectExtra });

    // Extra files (PDFs etc.)
    for (const [index, f] of extras.entries()) {
      const extraSourceMessageId = f.source_message_id ?? (sourceMessageId ? sourceMessageId + index + 1 : undefined);
      if (f.file_id) {
        if (f.kind === "document") await sendDocument(userChatId, f.file_id, { ...protectExtra });
        else if (f.kind === "video") await sendVideo(userChatId, f.file_id, { ...protectExtra });
        else if (f.kind === "audio") await sendAudio(userChatId, f.file_id, { ...protectExtra });
        else if (f.kind === "photo") await sendPhoto(userChatId, f.file_id, { ...protectExtra });
      } else if (extraSourceMessageId && sourceChatId) {
        // Backfilled extras — copy from source channel
        await copyMessage(userChatId, sourceChatId, extraSourceMessageId, { ...protectExtra });
      }
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

// -------- Queue reset helpers --------
export async function resetPostedPosts(db: SupabaseClient, limit: number): Promise<{ reset: number; codes: string[]; error?: string }> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const { data, error } = await db
    .from("posts")
    .select("id, code")
    .not("posted_at", "is", null)
    .order("posted_at", { ascending: false })
    .limit(safeLimit);

  if (error) return { reset: 0, codes: [], error: error.message };
  if (!data?.length) return { reset: 0, codes: [] };

  const ids = data.map((p) => p.id);
  const { error: updateError } = await db.from("posts").update({ posted_at: null }).in("id", ids);
  if (updateError) return { reset: 0, codes: [], error: updateError.message };

  return { reset: data.length, codes: data.map((p) => p.code).filter(Boolean) };
}

export async function resetAllPostedPosts(db: SupabaseClient): Promise<{ reset: number; error?: string }> {
  const { count, error } = await db
    .from("posts")
    .update({ posted_at: null }, { count: "exact" })
    .not("posted_at", "is", null);

  if (error) return { reset: 0, error: error.message };
  return { reset: count ?? 0 };
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
