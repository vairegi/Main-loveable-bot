// Import endpoint for the MTProto backfill script.
// The user generates an import token via /genimporttoken and passes it as
//   Authorization: Bearer <token>
// The script POSTs one post at a time (or a batch) so history flows into the queue.

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const MediaSchema = z.object({
  kind: z.enum(["photo", "video", "document", "audio", "text"]),
  file_id: z.string().optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
});

const ImportSchema = z.object({
  source_chat_id: z.number(),
  source_message_id: z.number(),
  caption: z.string().default(""),
  media: MediaSchema,
  extra_files: z.array(MediaSchema).default([]),
  media_group_id: z.string().nullable().optional(),
  created_at: z.string().optional(), // ISO timestamp of the original message
});

function randomCode(): string {
  // Same shape as posting.ts
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export const Route = createFileRoute("/api/public/telegram/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const db = getAdminDb();

        // Auth: bearer token stored in bot_settings.import_token
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.replace(/^Bearer\s+/i, "").trim();
        if (!token) return new Response("Unauthorized", { status: 401 });

        const { data: setting } = await db
          .from("bot_settings")
          .select("value")
          .eq("key", "import_token")
          .maybeSingle();
        const expected = (setting?.value as any)?.token as string | undefined;
        if (!expected || token !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const body = await request.json();
        const items = Array.isArray(body) ? body : [body];

        let inserted = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const raw of items) {
          const parsed = ImportSchema.safeParse(raw);
          if (!parsed.success) {
            errors.push(parsed.error.message);
            continue;
          }
          const p = parsed.data;

          // Skip duplicates
          const { data: existing } = await db
            .from("posts")
            .select("id")
            .eq("source_chat_id", p.source_chat_id)
            .eq("source_message_id", p.source_message_id)
            .maybeSingle();
          if (existing) {
            skipped++;
            continue;
          }

          const row: Record<string, unknown> = {
            code: randomCode(),
            source_chat_id: p.source_chat_id,
            source_message_id: p.source_message_id,
            caption: p.caption,
            media: p.media,
            extra_files: p.extra_files,
            media_group_id: p.media_group_id ?? null,
            posted_at: null,
          };
          if (p.created_at) row.created_at = p.created_at;

          const { error } = await db.from("posts").insert(row);
          if (error) errors.push(error.message);
          else inserted++;
        }

        return Response.json({ ok: true, inserted, skipped, errors: errors.slice(0, 5) });
      },
    },
  },
});
