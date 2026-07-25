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
  // Skip if base already contains this exact extra text (avoid duplicates).
  if (base.includes(extra.trim())) return base;
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
// Recognize "source message is gone / unreachable" errors from Telegram.
// These posts can never be published — archive them so they stop blocking
// the queue head, and notify the admin log channel with a source link.
function isSourceGoneError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return /message to copy not found|message not found|MESSAGE_ID_INVALID|chat not found|wasn'?t found|CHANNEL_INVALID|PEER_ID_INVALID/i.test(m);
}

// Build a t.me link for a source message (private supergroups/channels use
// the /c/<internalId>/<messageId> form). Returns null if we can't build one.
function buildSourceMessageLink(sourceChatId: unknown, sourceMessageId: unknown): string | null {
  const chat = typeof sourceChatId === "number" ? sourceChatId : Number(sourceChatId);
  const msg = typeof sourceMessageId === "number" ? sourceMessageId : Number(sourceMessageId);
  if (!Number.isFinite(chat) || !Number.isFinite(msg)) return null;
  const s = String(chat);
  if (s.startsWith("-100")) return `https://t.me/c/${s.slice(4)}/${msg}`;
  return null;
}

type MissingRef = {
  id: number;
  code?: string;
  source_chat_id?: number;
  source_message_id?: number;
  caption?: string;
  reason: string;
};

async function notifyAdminOfMissingPosts(db: SupabaseClient, missing: MissingRef[]): Promise<void> {
  if (!missing.length) return;
  const { data: setting } = await db
    .from("bot_settings")
    .select("value")
    .eq("key", "log_channel_id")
    .maybeSingle();
  const logChannelId = (setting?.value as any)?.chat_id;
  if (!logChannelId) return;

  const lines = missing.slice(0, 30).map((p) => {
    const link = buildSourceMessageLink(p.source_chat_id, p.source_message_id);
    const label = `#${p.id}${p.code ? ` (<code>${p.code}</code>)` : ""}`;
    const cap = (p.caption ?? "").slice(0, 60).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const capPart = cap ? ` — ${cap}` : "";
    return link
      ? `• ${label} — <a href="${link}">source msg</a>${capPart}`
      : `• ${label} — chat <code>${p.source_chat_id ?? "?"}</code> / msg <code>${p.source_message_id ?? "?"}</code>${capPart}`;
  });
  const more = missing.length > 30 ? `\n…and ${missing.length - 30} more` : "";
  const body =
    `⚠️ <b>Drip: ${missing.length} queued post(s) removed</b>\n` +
    `The original message in the database channel is gone (deleted, or the bot lost access). ` +
    `They can never be published, so they've been moved to the deleted-posts archive to unblock the queue.\n\n` +
    lines.join("\n") + more;
  try {
    await sendMessage(logChannelId, body);
  } catch {
    /* log channel unreachable — ignore */
  }
}

// Archive a queued post that can never be published, then delete it from posts.
async function quarantineMissingPost(db: SupabaseClient, post: any): Promise<void> {
  await db.from("deleted_posts").insert({
    original_post_id: post.id,
    code: post.code,
    source_chat_id: post.source_chat_id,
    source_message_id: post.source_message_id,
    caption: post.caption,
    media: post.media,
    extra_files: post.extra_files,
    media_group_id: post.media_group_id,
    fetch_count: post.fetch_count ?? 0,
    created_by: post.created_by,
    original_created_at: post.created_at,
    original_posted_at: null,
    deleted_by: null,
  });
  await db.from("posts").delete().eq("id", post.id);
}

export async function dripQueue(db: SupabaseClient, batchSize: number): Promise<{ posted: number; failed: number; drained: boolean; failures: DripFailure[]; quarantined: number }> {
  const { data: queue } = await db
    .from("posts")
    .select("*")
    .is("posted_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(batchSize);

  if (!queue?.length) return { posted: 0, failed: 0, drained: true, failures: [], quarantined: 0 };

  let posted = 0;
  let failed = 0;
  const failures: DripFailure[] = [];
  const missing: MissingRef[] = [];

  for (const post of queue) {
    try {
      await publishPost(db, post);
      await db.from("posts").update({ posted_at: new Date().toISOString() }).eq("id", post.id);
      posted++;
    } catch (e) {
      console.error("Drip publish failed:", post.id, e);
      const reason = dripFailureReason(e);
      if (isSourceGoneError(e)) {
        try {
          await quarantineMissingPost(db, post);
          missing.push({
            id: post.id,
            code: post.code,
            source_chat_id: post.source_chat_id,
            source_message_id: post.source_message_id,
            caption: post.caption,
            reason,
          });
          continue;
        } catch (archiveErr) {
          console.error("Quarantine failed for post", post.id, archiveErr);
        }
      }
      failed++;
      failures.push({ id: post.id, code: post.code, reason });
    }
  }

  await notifyAdminOfMissingPosts(db, missing);

  return { posted, failed, drained: queue.length < batchSize, failures, quarantined: missing.length };
}

export async function getPostPosition(db: SupabaseClient, post: { id?: number | string; created_at: string }): Promise<number> {
  const { count: beforeCount } = await db
    .from("posts")
    .select("id", { count: "exact", head: true })
    .lt("created_at", post.created_at);

  const postId = Number(post.id);
  if (!Number.isFinite(postId)) return (beforeCount ?? 0) + 1;

  const { count: sameTimeCount } = await db
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("created_at", post.created_at)
    .lte("id", postId);

  return (beforeCount ?? 0) + (sameTimeCount ?? 1);
}

async function publishPost(db: SupabaseClient, post: any, targetChatId?: number | string): Promise<void> {
  let mains: { telegram_chat_id: number | string }[] | null;
  if (targetChatId !== undefined) {
    mains = [{ telegram_chat_id: targetChatId }];
  } else {
    const { data } = await db.from("channels").select("telegram_chat_id").eq("role", "main");
    mains = data;
  }
  if (!mains?.length) throw new Error("No main channels registered");

  const botUsername = await getBotUsername();
  const template = await getCaptionTemplate(db);
  const position = await getPostPosition(db, post);
  const rendered = appendExtra(
    renderCaption(template, { caption: post.caption ?? "", code: post.code }),
    await getExtraCaption(db, "post_caption_extra"),
  );
  const captionText = `#${position}\n\n${rendered}`.trim();
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
  // Ban + rate-limit gate.
  const { getBotUser, checkAndBumpRate } = await import("./users");
  const bu = await getBotUser(db, userChatId);
  if (bu?.banned) {
    try { await sendMessage(userChatId, `🚫 You are banned from using this bot.${bu.banned_reason ? `\nReason: ${bu.banned_reason}` : ""}`); } catch { /* ignore */ }
    return "";
  }
  const rate = await checkAndBumpRate(db, userChatId);
  if (!rate.ok) {
    try { await sendMessage(userChatId, `⏳ Slow down — you're requesting files too fast. Try again in ${rate.retryAfterSeconds ?? 60}s.`); } catch { /* ignore */ }
    return "";
  }

  const { data: post } = await db.from("posts").select("*").eq("code", code).maybeSingle();
  if (!post) return "❌ Sorry, that file is no longer available.";

  // Force-subscribe gate: if any forcesub channels are configured, require the
  // user to be a member (or to have already sent a chat_join_request).
  const { unmetForceSubs, buildJoinKeyboard } = await import("./fsub");
  const unmet = await unmetForceSubs(db, userChatId);
  if (unmet.length) {
    const botUsername = await getBotUsername();
    const keyboard = buildJoinKeyboard(unmet, `get_${code}`, botUsername);
    const names = unmet.map((c) => `• <b>${c.title}</b>`).join("\n");
    try {
      await sendMessage(
        userChatId,
        `🔒 <b>Please join our channel(s) to get the file:</b>\n\n${names}\n\nAfter joining (or sending the join request), tap <b>I've Joined — Try Again</b>.`,
        { reply_markup: keyboard },
      );
    } catch { /* ignore */ }
    return "";
  }

  // Link-shortener verification gate (no-op when disabled).
  {
    const { requireVerification } = await import("./shortener");
    if (await requireVerification(db, userChatId, code)) return "";
  }

  const sourceChatId = post.source_chat_id ? chatId(post.source_chat_id) : undefined;
  const sourceMessageId = numericMessageId(post.source_message_id);
  const media = mediaWithSource((post.media ?? {}) as TgMedia, sourceMessageId);
  const postExtra = await getExtraCaption(db, "post_caption_extra");
  const fileExtra = await getExtraCaption(db, "file_caption_extra");
  const position = await getPostPosition(db, post);
  const caption = `#${position}\n\n${appendExtra(post.caption ?? "", postExtra)}`.trim();
  const extras = Array.isArray(post.extra_files) ? (post.extra_files as TgMedia[]) : [];
  const opts = await getPostingOptions(db);
  const protectExtra = opts.protect ? { protect_content: true } : {};
  const spoilerPhoto = opts.spoiler ? { has_spoiler: true } : {};

  const { getAutodeleteSeconds, queueDeletion, formatDuration } = await import("./autodelete");
  const autodeleteSeconds = await getAutodeleteSeconds(db);
  const sentIds: number[] = [];
  const track = (m: any) => { if (m?.message_id) sentIds.push(m.message_id); };

  try {
    // Cover — prefer file_id, fall back to copyMessage from source channel
    if (media.kind === "photo" && media.file_id) track(await sendPhoto(userChatId, media.file_id, { caption, ...protectExtra, ...spoilerPhoto }));
    else if (media.kind === "video" && media.file_id) track(await sendVideo(userChatId, media.file_id, { caption, ...protectExtra, ...spoilerPhoto }));
    else if (media.kind === "document" && media.file_id) track(await sendDocument(userChatId, media.file_id, { caption, ...protectExtra }));
    else if (media.kind === "audio" && media.file_id) track(await sendAudio(userChatId, media.file_id, { caption, ...protectExtra }));
    else if (media.kind !== "text" && sourceChatId && media.source_message_id) {
      track(await copyMessage(userChatId, sourceChatId, media.source_message_id, { caption, ...protectExtra }));
    } else if (caption) track(await sendMessage(userChatId, caption, { ...protectExtra }));

    // Extra files (PDFs etc.) — apply /filecaption
    const fOpt = fileExtra ? { caption: fileExtra } : {};
    for (const [index, f] of extras.entries()) {
      const extraSourceMessageId = f.source_message_id ?? (sourceMessageId ? sourceMessageId + index + 1 : undefined);
      if (f.file_id) {
        if (f.kind === "document") track(await sendDocument(userChatId, f.file_id, { ...protectExtra, ...fOpt }));
        else if (f.kind === "video") track(await sendVideo(userChatId, f.file_id, { ...protectExtra, ...fOpt }));
        else if (f.kind === "audio") track(await sendAudio(userChatId, f.file_id, { ...protectExtra, ...fOpt }));
        else if (f.kind === "photo") track(await sendPhoto(userChatId, f.file_id, { ...protectExtra, ...fOpt }));
      } else if (extraSourceMessageId && sourceChatId) {
        track(await copyMessage(userChatId, sourceChatId, extraSourceMessageId, { ...protectExtra, ...fOpt }));
      }
    }

    if (autodeleteSeconds > 0 && sentIds.length) {
      try {
        const warn = await sendMessage(
          userChatId,
          `⏳ These files will be auto-deleted in <b>${formatDuration(autodeleteSeconds)}</b>. Save what you need.`,
        );
        if (warn?.message_id) sentIds.push(warn.message_id);
      } catch { /* ignore */ }
      await queueDeletion(db, userChatId, sentIds, autodeleteSeconds);
    }

    // Reaction buttons (❤️ save · 👍 · 👎)
    try {
      const { buildReactionKeyboard, getReactionState } = await import("./reactions");
      const state = await getReactionState(db, post.id, userChatId);
      const botUsername = await getBotUsername();
      const kb = buildReactionKeyboard(post.id, botUsername, post.code, state);
      await sendMessage(
        userChatId,
        `<i>Rate this post</i>${state.score ? ` — score <b>${state.score > 0 ? "+" : ""}${state.score}</b>` : ""}`,
        { reply_markup: kb },
      );
    } catch (e) {
      console.error("reaction keyboard failed:", e);
    }

    // Bookkeeping: bump per-post + per-user fetch counters (best-effort).
    try {
      await db.from("posts").update({ fetch_count: (post.fetch_count ?? 0) + 1 }).eq("id", post.id);
      const { data: cur } = await db.from("bot_users").select("fetch_count").eq("telegram_user_id", userChatId).maybeSingle();
      await db.from("bot_users").update({ fetch_count: (cur?.fetch_count ?? 0) + 1 }).eq("telegram_user_id", userChatId);
    } catch { /* ignore */ }

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

// Parse a t.me link like https://t.me/c/2298797194/2135 or
// https://t.me/somechannel/2135 into { sourceChatId, messageId }.
// Private channels (t.me/c/<id>/<msg>) need the -100 prefix on the numeric id.
export function parseTelegramPostLink(link: string): { sourceChatId: number | string; messageId: number } | null {
  const m = link.trim().match(/t\.me\/(c\/(-?\d+)|([A-Za-z0-9_]+))\/(\d+)/);
  if (!m) return null;
  const msgId = Number(m[4]);
  if (!Number.isFinite(msgId)) return null;
  if (m[2]) {
    const raw = m[2].replace(/^-/, "");
    const chatId = Number(`-100${raw}`);
    return { sourceChatId: chatId, messageId: msgId };
  }
  return { sourceChatId: `@${m[3]}`, messageId: msgId };
}

// Manually publish a post by its source (database channel) link.
export async function postByLink(db: SupabaseClient, link: string, targetChatId?: number | string): Promise<string> {
  const parsed = parseTelegramPostLink(link);
  if (!parsed) return `❌ Not a valid Telegram post link: <code>${link}</code>`;

  // Try direct match on source message id, then fall back to any attached extra file.
  const { data: direct } = await db
    .from("posts")
    .select("*")
    .eq("source_chat_id", parsed.sourceChatId)
    .eq("source_message_id", parsed.messageId)
    .maybeSingle();

  let post = direct;
  if (!post) {
    // Maybe this link points to an attached file — find the parent post.
    const { data: candidates } = await db
      .from("posts")
      .select("*")
      .eq("source_chat_id", parsed.sourceChatId)
      .contains("extra_files", [{ source_message_id: parsed.messageId }]);
    post = candidates?.[0] ?? null;
  }

  if (!post) return `❌ No stored post found for <a href="${link}">${parsed.messageId}</a>. Run /scandatabase first if it's new.`;

  try {
    await publishPost(db, post, targetChatId);
    const where = targetChatId !== undefined ? ` to <code>${targetChatId}</code>` : "";
    return `✅ Manually posted <code>${post.code}</code> (msg ${parsed.messageId})${where}.`;
  } catch (e: any) {
    return `❌ Post failed for msg ${parsed.messageId}: ${e?.message ?? "unknown"}`;
  }
}

export async function deletePostByCode(db: SupabaseClient, code: string, deletedBy?: number): Promise<string> {
  const { data: post } = await db.from("posts").select("*").eq("code", code).maybeSingle();
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

  // Archive to deleted_posts so /undelete can restore.
  await db.from("deleted_posts").insert({
    original_post_id: post.id,
    code: post.code,
    source_chat_id: post.source_chat_id,
    source_message_id: post.source_message_id,
    caption: post.caption,
    media: post.media ?? {},
    extra_files: post.extra_files ?? [],
    media_group_id: post.media_group_id ?? null,
    fetch_count: post.fetch_count ?? 0,
    created_by: post.created_by ?? null,
    original_created_at: post.created_at ?? null,
    original_posted_at: post.posted_at ?? null,
    deleted_by: deletedBy ?? null,
  });

  await db.from("posts").delete().eq("id", post.id);
  return `🗑️ Deleted post <code>${code}</code> — ${deleted} copies removed${failed ? `, ${failed} failed` : ""}.\n↩️ Restore with <code>/undelete ${code}</code>.`;
}

export async function undeletePostByCode(db: SupabaseClient, code: string): Promise<string> {
  const { data: archived } = await db
    .from("deleted_posts")
    .select("*")
    .eq("code", code)
    .order("deleted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!archived) return `❌ No archived post found with code <code>${code}</code>.`;

  const { data: existing } = await db.from("posts").select("id").eq("code", code).maybeSingle();
  if (existing) return `⚠️ A live post with code <code>${code}</code> already exists (id ${existing.id}). Aborting restore.`;

  const { data: restored, error } = await db
    .from("posts")
    .insert({
      code: archived.code,
      source_chat_id: archived.source_chat_id,
      source_message_id: archived.source_message_id,
      caption: archived.caption,
      media: archived.media ?? {},
      extra_files: archived.extra_files ?? [],
      media_group_id: archived.media_group_id ?? null,
      fetch_count: archived.fetch_count ?? 0,
      created_by: archived.created_by ?? null,
      created_at: archived.original_created_at ?? undefined,
      posted_at: null, // re-enter the queue so it gets republished
    })
    .select("id")
    .single();

  if (error || !restored) return `❌ Restore failed: ${error?.message ?? "unknown"}`;

  await db.from("deleted_posts").delete().eq("id", archived.id);

  return `♻️ Restored post <code>${code}</code> (new id ${restored.id}). It's back in the queue — use <code>/repost ${code}</code> to publish immediately.`;
}

export async function listDeletedPosts(db: SupabaseClient, limit = 20): Promise<Array<{ code: string; deleted_at: string; caption: string | null }>> {
  const { data } = await db
    .from("deleted_posts")
    .select("code, deleted_at, caption")
    .order("deleted_at", { ascending: false })
    .limit(limit);
  return data ?? [];
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
// `pending` tracks an in-flight slot so the drip hook can publish in small
// chunks across successive Worker invocations without losing progress if any
// single Worker times out. The slot is only added to `done_slots` after all
// posts for it have been processed.
export type PendingSlot = { date: string; slot: string; remaining: number };
export type Schedule =
  | { enabled: false }
  | { enabled: true; mode: "interval"; interval_minutes: number; batch_size: number; last_drip_at?: string | null; pending?: PendingSlot }
  | { enabled: true; mode: "times"; times: string[]; per_slot: number; tz_offset_minutes: number; slots_done_for?: string /* YYYY-MM-DD */; done_slots?: string[]; pending?: PendingSlot };

export async function getSchedule(db: SupabaseClient): Promise<Schedule> {
  const v = await getSetting<Schedule>(db, "schedule");
  return v ?? { enabled: false };
}

export async function saveSchedule(db: SupabaseClient, s: Schedule): Promise<void> {
  await setSetting(db, "schedule", s);
}

export interface DripDecision {
  batchSize: number;
  slotKey?: string; // e.g. "2026-07-15|07:00" — pass to commitSlotProgress
}

// Decide how many posts to drip right now, WITHOUT marking the slot as done.
// The slot only advances (or gets removed from pending) once
// `commitSlotProgress` is called with the number of posts actually processed.
export async function computeDripDecision(db: SupabaseClient, chunkSize: number): Promise<DripDecision> {
  const sched = await getSchedule(db);
  if (!sched.enabled) return { batchSize: 0 };
  if (chunkSize <= 0) chunkSize = 5;

  const now = new Date();

  if (sched.mode === "interval") {
    // Resume an in-flight interval batch first.
    if (sched.pending && sched.pending.remaining > 0) {
      return {
        batchSize: Math.min(sched.pending.remaining, chunkSize),
        slotKey: `interval|${sched.pending.date}|${sched.pending.slot}`,
      };
    }
    const last = sched.last_drip_at ? new Date(sched.last_drip_at) : null;
    const dueAt = last ? new Date(last.getTime() + sched.interval_minutes * 60_000) : now;
    if (now < dueAt) return { batchSize: 0 };
    const token = now.toISOString();
    await saveSchedule(db, {
      ...sched,
      last_drip_at: token,
      pending: { date: token.slice(0, 10), slot: token, remaining: sched.batch_size },
    });
    return { batchSize: Math.min(sched.batch_size, chunkSize), slotKey: `interval|${token.slice(0, 10)}|${token}` };
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

    // 1) Resume an in-flight slot from today first.
    const pending = sched.pending;
    if (pending && pending.date === dateKey && pending.remaining > 0) {
      return {
        batchSize: Math.min(pending.remaining, chunkSize),
        slotKey: `${dateKey}|${pending.slot}`,
      };
    }

    // 2) Otherwise claim the first due, unfinished slot for today.
    for (const t of sched.times) {
      const [h, m] = t.split(":").map((x) => Number(x));
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      const slotMin = h * 60 + m;
      if (nowMinutes >= slotMin && !doneSlots.includes(t)) {
        await saveSchedule(db, {
          ...sched,
          pending: { date: dateKey, slot: t, remaining: sched.per_slot },
        });
        return { batchSize: Math.min(sched.per_slot, chunkSize), slotKey: `${dateKey}|${t}` };
      }
    }
    return { batchSize: 0 };
  }

  return { batchSize: 0 };
}

// Legacy shim — some callers may still use this. Prefer computeDripDecision.
export async function computeDripBatch(db: SupabaseClient): Promise<number> {
  return (await computeDripDecision(db, 5)).batchSize;
}

// Record how many posts we actually processed for the currently-pending slot.
// Returns { finished: true } when the slot is fully drained and we've moved it
// into `done_slots`.
export async function commitSlotProgress(
  db: SupabaseClient,
  slotKey: string | undefined,
  processed: number,
): Promise<{ finished: boolean }> {
  if (!slotKey || processed <= 0) return { finished: false };
  const sched = await getSchedule(db);
  if (!sched.enabled) return { finished: false };

  // interval mode carries its own pending; times mode uses date|slot
  if (sched.mode === "interval") {
    if (!slotKey.startsWith("interval|")) return { finished: false };
    const pending = sched.pending;
    if (!pending) return { finished: false };
    const remaining = Math.max(pending.remaining - processed, 0);
    if (remaining <= 0) {
      const { pending: _drop, ...rest } = sched;
      await saveSchedule(db, rest as Schedule);
      return { finished: true };
    }
    await saveSchedule(db, { ...sched, pending: { ...pending, remaining } });
    return { finished: false };
  }

  if (sched.mode === "times") {
    const [dateKey, slot] = slotKey.split("|");
    const pending = sched.pending;
    if (!pending || pending.date !== dateKey || pending.slot !== slot) return { finished: false };
    const remaining = Math.max(pending.remaining - processed, 0);
    if (remaining <= 0) {
      const doneSlots = sched.slots_done_for === dateKey ? (sched.done_slots ?? []) : [];
      const { pending: _drop, ...rest } = sched;
      await saveSchedule(db, {
        ...(rest as Schedule),
        // TS: we know mode is "times"
        slots_done_for: dateKey,
        done_slots: doneSlots.includes(slot) ? doneSlots : [...doneSlots, slot],
      } as Schedule);
      return { finished: true };
    }
    await saveSchedule(db, { ...sched, pending: { ...pending, remaining } });
    return { finished: false };
  }

  return { finished: false };
}

export async function queueSize(db: SupabaseClient): Promise<number> {
  const { count } = await db.from("posts").select("*", { count: "exact", head: true }).is("posted_at", null);
  return count ?? 0;
}
