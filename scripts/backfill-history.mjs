#!/usr/bin/env node
// Backfill script — reads the entire history of your Telegram database channel
// using your USER account (via MTProto / gramjs) and POSTs each post into the
// bot's queue via the /api/public/telegram/import endpoint.
//
// This runs on YOUR local machine, one time. It is NOT part of the deployed app.
//
// Setup (do once):
//   1. Get api_id and api_hash from https://my.telegram.org  ->  API development tools
//   2. In Telegram, message @Douginshibot and send:  /genimporttoken
//      Copy the token it returns.
//   3. Get the numeric chat id of your database channel (forward any msg from it
//      to @userinfobot -> it prints the id, negative for channels).
//   4. In this project folder locally, install gramjs:
//        npm i telegram input
//   5. Set env vars and run:
//        TG_API_ID=123456 \
//        TG_API_HASH=abcdef0123456789abcdef0123456789 \
//        BOT_IMPORT_URL=https://project--63054181-241c-4222-a8c4-6a324a5c7656-dev.lovable.app/api/public/telegram/import \
//        BOT_IMPORT_TOKEN=<paste token from /genimporttoken> \
//        SOURCE_CHAT_ID=-1001234567890 \
//        node scripts/backfill-history.mjs
//
//   On first run it asks for your phone number and the login code Telegram texts you.
//   The session string is printed at the end — save it to skip login next time
//   by setting TG_SESSION=<string>.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const {
  TG_API_ID,
  TG_API_HASH,
  TG_SESSION = "",
  BOT_IMPORT_URL,
  BOT_IMPORT_TOKEN,
  SOURCE_CHAT_ID,
  BATCH_SIZE = "50",
  FILE_WINDOW_MINUTES = "360", // group file-only messages arriving within this window after the caption message
} = process.env;

for (const [k, v] of Object.entries({ TG_API_ID, TG_API_HASH, BOT_IMPORT_URL, BOT_IMPORT_TOKEN, SOURCE_CHAT_ID })) {
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

const apiId = Number(TG_API_ID);
const apiHash = TG_API_HASH;
const sourceChatId = Number(SOURCE_CHAT_ID);
const batchSize = Math.max(1, Math.min(100, Number(BATCH_SIZE)));
const fileWindowMs = Number(FILE_WINDOW_MINUTES) * 60_000;

const session = new StringSession(TG_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

function classify(msg) {
  if (msg.photo) return "main";
  if (msg.video) return (msg.message || "").trim() ? "main" : "file";
  if (msg.document || msg.audio) return "file";
  return "main"; // text-only
}

function extractMedia(msg) {
  // gramjs message shape: msg.media (photo/document). We need Bot API-compatible file_ids.
  // NOTE: MTProto file references are NOT the same as Bot API file_ids. To get bot-usable
  // file_ids we resend the message to a "staging" chat that the bot admins — this is a
  // Telegram limitation. Simplest reliable approach: forward the message to the bot itself
  // and let it capture channel_post-style updates.
  //
  // For a lightweight import that keeps captions + text + album grouping, we omit file_id
  // here (media.kind is still recorded so the queue orders correctly) and rely on the bot
  // being able to fetch the file at delivery time via copyMessage from the source channel.
  if (msg.photo) return { kind: "photo" };
  if (msg.video || msg.document?.mimeType?.startsWith("video/")) return { kind: "video" };
  if (msg.audio || msg.document?.mimeType?.startsWith("audio/")) return { kind: "audio" };
  if (msg.document) return { kind: "document", file_name: msg.document.attributes?.find?.((a) => a.fileName)?.fileName, mime_type: msg.document.mimeType };
  return { kind: "text" };
}

async function postBatch(items) {
  const res = await fetch(BOT_IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BOT_IMPORT_TOKEN}` },
    body: JSON.stringify(items),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Import failed:", res.status, body);
    process.exit(1);
  }
  console.log(`  → inserted=${body.inserted} skipped=${body.skipped} errors=${(body.errors ?? []).length}`);
}

async function main() {
  await client.start({
    phoneNumber: async () => input.text("Phone number (international format, e.g. +1234567890): "),
    password: async () => input.text("2FA password (leave blank if none): "),
    phoneCode: async () => input.text("Login code from Telegram: "),
    onError: (err) => console.error(err),
  });

  console.log("\nSession string (save as TG_SESSION for next run):\n" + client.session.save() + "\n");
  console.log(`Reading history from chat ${sourceChatId}...`);

  const entity = await client.getEntity(sourceChatId);
  // Collect all messages oldest-first
  const all = [];
  for await (const msg of client.iterMessages(entity, { limit: 100000, reverse: true })) {
    all.push(msg);
  }
  console.log(`Fetched ${all.length} messages. Grouping into posts...`);

  // Group: each "main" starts a post, following "file" messages attach.
  const posts = [];
  let current = null;
  for (const msg of all) {
    const kind = classify(msg);
    const media = extractMedia(msg);
    const iso = new Date((msg.date ?? 0) * 1000).toISOString();

    if (kind === "main") {
      current = {
        source_chat_id: sourceChatId,
        source_message_id: msg.id,
        caption: msg.message || "",
        media,
        extra_files: [],
        media_group_id: msg.groupedId ? String(msg.groupedId) : null,
        created_at: iso,
      };
      posts.push(current);
    } else if (kind === "file") {
      if (current && (msg.date * 1000 - new Date(current.created_at).getTime()) <= fileWindowMs) {
        current.extra_files.push({ ...media });
      } else {
        // Orphan file: keep as its own post so nothing is lost
        posts.push({
          source_chat_id: sourceChatId,
          source_message_id: msg.id,
          caption: "",
          media,
          extra_files: [],
          media_group_id: msg.groupedId ? String(msg.groupedId) : null,
          created_at: iso,
        });
      }
    }
  }
  console.log(`Grouped into ${posts.length} posts. Uploading in batches of ${batchSize}...`);

  for (let i = 0; i < posts.length; i += batchSize) {
    const chunk = posts.slice(i, i + batchSize);
    console.log(`Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(posts.length / batchSize)} (${chunk.length} posts)`);
    await postBatch(chunk);
  }
  console.log("\n✅ Done. Run /queue in the bot to confirm, then /setschedule to start drip-posting.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
