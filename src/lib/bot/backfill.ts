// Backfill — republish a range of already-stored posts into a channel that
// missed them (e.g. a channel that stopped receiving posts for a while).
//
// The job is resumable: state lives in bot_settings.key = 'backfill_job' and is
// advanced a few posts per cron tick, so a range of hundreds of posts never
// hits the Worker time limit.

import type { SupabaseClient } from "@supabase/supabase-js";
import { publishPostToChannel } from "./posting";

export const BACKFILL_KEY = "backfill_job";

export interface BackfillJob {
  chatIds: number[];
  fromPos: number;
  toPos: number;
  nextPos: number;
  posted: number;
  skipped: number;
  failed: number;
  lastError?: string | null;
  requesterChatId?: number | null;
  statusMessageId?: number | null;
  createdBy?: number | null;
  createdAt: string;
  updatedAt: string;
}

export async function getBackfillJob(db: SupabaseClient): Promise<BackfillJob | null> {
  const { data } = await db.from("bot_settings").select("value").eq("key", BACKFILL_KEY).maybeSingle();
  const job = (data?.value ?? null) as BackfillJob | null;
  if (!job || !Array.isArray(job.chatIds) || !job.chatIds.length) return null;
  return job;
}

export async function saveBackfillJob(db: SupabaseClient, job: BackfillJob | null): Promise<void> {
  await db.from("bot_settings").upsert(
    { key: BACKFILL_KEY, value: (job ?? {}) as any, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}

export async function clearBackfillJob(db: SupabaseClient): Promise<void> {
  await saveBackfillJob(db, null);
}

export async function totalPostCount(db: SupabaseClient): Promise<number> {
  const { count } = await db.from("posts").select("id", { count: "exact", head: true });
  return Number(count ?? 0);
}

/**
 * Create a backfill job covering post positions [fromPos, toPos] (1-based,
 * same numbering shown as "#N" in channel captions).
 */
export async function startBackfill(
  db: SupabaseClient,
  opts: {
    chatIds: number[];
    fromPos: number;
    toPos?: number;
    requesterChatId?: number;
    createdBy?: number;
  },
): Promise<BackfillJob> {
  const total = await totalPostCount(db);
  const toPos = Math.min(opts.toPos ?? total, total);
  const now = new Date().toISOString();
  const job: BackfillJob = {
    chatIds: opts.chatIds,
    fromPos: Math.max(1, opts.fromPos),
    toPos,
    nextPos: Math.max(1, opts.fromPos),
    posted: 0,
    skipped: 0,
    failed: 0,
    lastError: null,
    requesterChatId: opts.requesterChatId ?? null,
    statusMessageId: null,
    createdBy: opts.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await saveBackfillJob(db, job);
  return job;
}

/**
 * Process one chunk of the active backfill job.
 * Returns null when there is no job.
 */
export async function runBackfillChunk(
  db: SupabaseClient,
  chunkSize = 5,
): Promise<{ job: BackfillJob; done: boolean; processed: number } | null> {
  const job = await getBackfillJob(db);
  if (!job) return null;

  if (job.nextPos > job.toPos) {
    return { job, done: true, processed: 0 };
  }

  const remaining = job.toPos - job.nextPos + 1;
  const take = Math.min(chunkSize, remaining);
  const startIdx = job.nextPos - 1;

  const { data: batch, error } = await db
    .from("posts")
    .select("*")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(startIdx, startIdx + take - 1);

  if (error) {
    job.lastError = error.message;
    job.updatedAt = new Date().toISOString();
    await saveBackfillJob(db, job);
    return { job, done: false, processed: 0 };
  }

  let processed = 0;
  for (const post of batch ?? []) {
    for (const cid of job.chatIds) {
      try {
        const { count } = await db
          .from("post_copies")
          .select("id", { count: "exact", head: true })
          .eq("post_id", post.id)
          .eq("main_chat_id", cid);
        if (Number(count ?? 0) > 0) {
          job.skipped++;
          continue;
        }
        await publishPostToChannel(db, post, cid);
        job.posted++;
      } catch (e) {
        job.failed++;
        job.lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!post.posted_at) {
      await db.from("posts").update({ posted_at: new Date().toISOString() }).eq("id", post.id);
    }
    processed++;
    job.nextPos++;
  }

  job.updatedAt = new Date().toISOString();
  const done = job.nextPos > job.toPos || processed === 0;
  if (done) {
    await clearBackfillJob(db);
  } else {
    await saveBackfillJob(db, job);
  }
  return { job, done, processed };
}

export function backfillStatusText(job: BackfillJob): string {
  const total = job.toPos - job.fromPos + 1;
  const done = Math.max(0, Math.min(total, job.nextPos - job.fromPos));
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  return (
    `♻️ <b>Backfill</b> → ${job.chatIds.map((c) => `<code>${c}</code>`).join(", ")}\n` +
    `Range: #${job.fromPos} → #${job.toPos}\n` +
    `${bar}  <b>${pct}%</b> (${done}/${total})\n` +
    `Posted: <b>${job.posted}</b> · Skipped: ${job.skipped} · Failed: ${job.failed}` +
    (job.lastError ? `\n⚠️ ${String(job.lastError).slice(0, 150)}` : "")
  );
}
