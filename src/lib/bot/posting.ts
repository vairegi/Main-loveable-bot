// Posting engine — handles new posts from database channels and delivers files via deep-link.

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
}

// Extract media from a channel post
export function extractMedia(msg: any): TgMedia {
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
    // Largest resolution is the last entry
    const largest = msg.photo[msg.photo.length - 1];
    return { kind: "photo", file_id: largest.file_id };
  }
  if (msg.video) return { kind: "video", file_id: msg.video.file_id, file_name: msg.video.file_name, mime_type: msg.video.mime_type };
  if (msg.document) return { kind: "document", file_id: msg.document.file_id, file_name: msg.document.file_name, mime_type: msg.document.mime_type };
  if (msg.audio) return { kind: "audio", file_id: msg.audio.file_id, file_name: msg.audio.file_name, mime_type: msg.audio.mime_type };
  return { kind: "text" };
}

function randomCode(): string {
  return randomBytes(6).toString("base64url"); // ~8 chars, URL-safe
}

async function getSetting<T = any>(db: SupabaseClient, key: string): Promise<T | null> {
  const { data } = await db.from("bot_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? null;
}

async function isPaused(db: SupabaseClient): Promise<boolean> {
  const v = await getSetting<{ paused: boolean }>(db, "posting_paused");
  return !!v?.paused;
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

// Called when a new channel_post arrives from a registered "database" channel
export async function handleDatabaseChannelPost(db: SupabaseClient, msg: any): Promise<void> {
  const sourceChatId = msg.chat.id as number;
  const sourceMessageId = msg.message_id as number;

  // Skip duplicates
  const { data: existing } = await db
    .from("posts")
    .select("id, code")
    .eq("source_chat_id", sourceChatId)
    .eq("source_message_id", sourceMessageId)
    .maybeSingle();
  if (existing) return;

  const media = extractMedia(msg);
  const originalCaption = (msg.caption ?? msg.text ?? "") as string;

  const code = randomCode();
  const { data: inserted, error } = await db
    .from("posts")
    .insert({
      code,
      source_chat_id: sourceChatId,
      source_message_id: sourceMessageId,
      caption: originalCaption,
      media,
      created_by: msg.from?.id ?? null,
    })
    .select("id, code")
    .single();

  if (error || !inserted) {
    console.error("Failed to store post:", error);
    return;
  }

  if (await isPaused(db)) {
    return; // stored but not posted
  }

  await postToMainChannels(db, inserted.id, inserted.code);
}

export async function postToMainChannels(db: SupabaseClient, postId: number, code: string): Promise<{ posted: number; failed: number }> {
  const { data: post } = await db.from("posts").select("*").eq("id", postId).maybeSingle();
  if (!post) return { posted: 0, failed: 0 };

  const { data: mains } = await db.from("channels").select("telegram_chat_id").eq("role", "main");
  if (!mains?.length) return { posted: 0, failed: 0 };

  const botUsername = await getBotUsername();
  const template = await getCaptionTemplate(db);
  const captionText = renderCaption(template, { caption: post.caption ?? "", code });
  const keyboard = buildGetFileKeyboard(botUsername, code);

  let posted = 0;
  let failed = 0;

  for (const ch of mains) {
    try {
      // Use copyMessage so the main channel post looks native (any media type),
      // but we OVERRIDE the caption to include the CTA + button.
      const result = await copyMessage(ch.telegram_chat_id, post.source_chat_id, post.source_message_id, {
        caption: captionText,
        reply_markup: keyboard,
      });
      await db.from("post_copies").insert({
        post_id: post.id,
        main_chat_id: ch.telegram_chat_id,
        main_message_id: (result as any).message_id,
      });
      posted++;
    } catch (e) {
      console.error("Copy to main failed:", ch.telegram_chat_id, e);
      failed++;
    }
  }

  return { posted, failed };
}

// Deliver file to a user who clicked the deep-link
export async function deliverFileByCode(db: SupabaseClient, userChatId: number, code: string): Promise<string> {
  const { data: post } = await db.from("posts").select("*").eq("code", code).maybeSingle();
  if (!post) return "❌ Sorry, that file is no longer available.";

  const media = (post.media ?? {}) as TgMedia;
  const caption = post.caption ?? "";

  try {
    if (media.kind === "photo" && media.file_id) {
      await sendPhoto(userChatId, media.file_id, { caption });
    } else if (media.kind === "video" && media.file_id) {
      await sendVideo(userChatId, media.file_id, { caption });
    } else if (media.kind === "document" && media.file_id) {
      await sendDocument(userChatId, media.file_id, { caption });
    } else if (media.kind === "audio" && media.file_id) {
      await sendAudio(userChatId, media.file_id, { caption });
    } else {
      // No media — fall back to copyMessage so text posts still work
      await copyMessage(userChatId, post.source_chat_id, post.source_message_id);
    }
    return "";
  } catch (e: any) {
    console.error("Deliver failed:", e);
    return `❌ Couldn't send you the file: ${e?.message ?? "unknown error"}`;
  }
}

// Repost: re-run the auto-post for a stored post code
export async function repostByCode(db: SupabaseClient, code: string): Promise<string> {
  const { data: post } = await db.from("posts").select("id").eq("code", code).maybeSingle();
  if (!post) return `❌ No post found with code <code>${code}</code>.`;
  const { posted, failed } = await postToMainChannels(db, post.id, code);
  return `✅ Repost complete — ${posted} posted, ${failed} failed.`;
}

// Delete: remove all copies from main channels and the record itself
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

// Update the caption on all copies for a post (used after /setcaption for existing posts — optional; here we just update template)
export async function editCaptionOnCopies(
  db: SupabaseClient,
  postId: number,
  code: string,
): Promise<void> {
  const { data: post } = await db.from("posts").select("*").eq("id", postId).maybeSingle();
  if (!post) return;
  const { data: copies } = await db.from("post_copies").select("*").eq("post_id", postId);
  if (!copies?.length) return;

  const botUsername = await getBotUsername();
  const template = await getCaptionTemplate(db);
  const captionText = renderCaption(template, { caption: post.caption ?? "", code });
  const keyboard = buildGetFileKeyboard(botUsername, code);

  for (const c of copies) {
    try {
      await editMessageCaption(c.main_chat_id, c.main_message_id, captionText, { reply_markup: keyboard });
    } catch (e) {
      console.error("Edit caption failed:", e);
    }
  }
}
