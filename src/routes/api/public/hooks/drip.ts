// Drip scheduler endpoint — called by pg_cron every few minutes.
//
// Design:
//  1. `computeDripDecision` claims (or resumes) a pending slot without marking
//     it done. It returns how many posts to publish this tick, capped at
//     CHUNK_SIZE so a single Worker invocation never has to make hundreds of
//     sequential Telegram API calls.
//  2. `dripQueue` publishes that chunk.
//  3. `commitSlotProgress` decrements the pending slot's `remaining` counter
//     by the number of posts we actually processed. When it hits zero, the
//     slot is finally moved into `done_slots`. If the Worker crashed or timed
//     out before this step, the pending slot stays alive and the next cron
//     tick (or the self-chain below) picks up exactly where it left off.
//  4. If the slot still has work, we fire an unawaited fetch back to
//     ourselves so the next chunk starts in a fresh Worker with a fresh time
//     budget — no waiting 5 minutes for the next cron tick. That lets a
//     15-post slot finish within seconds even with several main channels.

import { createFileRoute } from "@tanstack/react-router";

// Posts per Worker invocation. Kept low so we stay well under Cloudflare
// wall-time limits regardless of how many main channels are registered.
const CHUNK_SIZE = 5;

export const Route = createFileRoute("/api/public/hooks/drip")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const { computeDripDecision, commitSlotProgress, dripQueue } = await import("@/lib/bot/posting");
        const db = getAdminDb();

        const decision = await computeDripDecision(db, CHUNK_SIZE);
        if (decision.batchSize <= 0) {
          return Response.json({ ok: true, skipped: true });
        }

        const result = await dripQueue(db, decision.batchSize);
        const processed = result.posted + result.quarantined + result.failed;

        let finished = true;
        if (decision.slotKey) {
          const r = await commitSlotProgress(db, decision.slotKey, processed);
          finished = r.finished;
        }

        // Slot still has work — kick off the next chunk immediately in a
        // fresh Worker invocation. `processed > 0` guards against tight
        // failure loops (if we processed 0, next cron tick will retry).
        if (!finished && processed > 0) {
          try {
            const url = new URL(request.url);
            // Fire-and-forget; a Response with an unresolved fetch is fine on Workers.
            void fetch(url.toString(), { method: "POST" }).catch(() => {});
          } catch {
            /* ignore */
          }
        }

        return Response.json({ ok: true, ...result, finished });
      },
    },
  },
});
