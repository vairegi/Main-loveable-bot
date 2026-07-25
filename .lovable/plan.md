# Plan — new bot features

Big batch. Before I build, a few clarifications inline (marked ❓) so we don't ship the wrong thing.

## 1. Discovery commands (users)

Only pull from **posts that have been posted to a main channel** (i.e. exist in `post_copies`), never raw database queue.

- **/random** — pick 1 random posted post, send as a mini card with a deep link (Get File button).
- **/recent** — last 10 posted posts, numbered list with deep links.
- **/trending** — top 10 posts by fetch count in the last 7 days (from `activity_log` where `action='file_fetch'`).
- **/similar `<tag>`** — user passes a hashtag like `#incest`. We match posts whose caption contains that hashtag (case-insensitive), return top 10 most recent posted ones with deep links.
  - ❓ If no `#` prefix given, should I auto-add one, or reject? Default: auto-add.

## 2. /leaderboard
Top 10 users by **files fetched** (last 30 days), with fetch counts. Admin-only? Or public to users too?
- ❓ Default: **public to users**, shows first name + count, no usernames leaked.

## 3. Scheduled posting — /postlater

Admin-only. Two shapes:

- `/postlater <duration> <code|link>` — schedule an existing DB post by code/link.
- Reply to a media message in the bot with `/postlater <duration>` — bot ingests that media as a new DB post, then schedules it.

Duration parser: `5h`, `2m`, `10m`, `1d`, or combined `5h 2m` / `1h30m`.

Storage: new `scheduled_posts` table `(id, post_id, run_at, created_by, status, created_at)`.
Runner: piggyback the existing per-minute drip cron — before draining the drip queue, promote any `scheduled_posts` whose `run_at <= now()` into an immediate post to main channels.

- ❓ Where should replied-to media be stored — as a normal DB post (so it also enters the regular drip queue for future posting) or as a **one-shot** that only fires at the scheduled time and is not queued? Default: **one-shot**, marked so drip skips it.

## 4. /broadcastlater
Admin-only. `/broadcastlater <duration> <text>` or reply to a message with `/broadcastlater <duration>`.
Reuses existing `broadcast_jobs` table — adds a `scheduled_for` column and a `status='scheduled'` state. The broadcast cron promotes scheduled jobs when due.

## 5. /exportusers
Admin-only. Generate CSV of `bot_users` (telegram_user_id, username, first_name, last_seen, banned, fetch_count) and upload as a document to the admin who ran it. Uses Telegram `sendDocument` with `InputFile` (multipart).

## 6. /stats upgrades
Append to existing `/stats` output:
- **Daily active users** (last 24h, distinct actors in `activity_log`)
- **Fetches today** (count of `file_fetch` in last 24h)
- **Shortener conversion rate** (last 7d): `verifications_completed / verifications_issued` from `bot_users` sh_* columns + `activity_log` shortener events. If we don't currently log "issued", add a lightweight counter.

## 7. Live tail of activity_log (web admin)
On the existing `/admin` page → **Activity** tab: add realtime tail. Uses Supabase Realtime `postgres_changes` on `public.activity_log` INSERT, prepends new rows to the table live. Enable realtime for that table via migration (`ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_log`).

## Schema changes (one migration)
- `scheduled_posts` table + GRANTs + RLS (service_role only; policies deny others).
- `broadcast_jobs`: add `scheduled_for timestamptz null`.
- `activity_log`: add to `supabase_realtime` publication + `REPLICA IDENTITY FULL` if needed.
- Optionally: `bot_settings` counters for shortener issued/completed if not already tracked.

## Files touched
- `src/lib/bot/commands.ts` — new commands + /stats extension
- `src/lib/bot/command-catalog.ts` — catalog entries (per project rule)
- `src/lib/bot/discovery.ts` (new) — random/recent/trending/similar helpers
- `src/lib/bot/scheduling.ts` (new) — postlater + broadcastlater helpers
- `src/lib/bot/export.ts` (new) — CSV + sendDocument
- `src/routes/api/public/hooks/drip.ts` — promote due scheduled_posts
- `src/routes/api/public/hooks/broadcast.ts` — promote due scheduled broadcasts
- `src/routes/_authenticated/admin.tsx` — realtime tail on Activity tab
- one Supabase migration

## Please confirm the ❓ items
1. `/similar` without `#` → auto-add? (default yes)
2. `/leaderboard` visible to normal users? (default yes, first name only)
3. `/postlater` on replied media → one-shot, not queued? (default yes)

Reply with any overrides, or just "go" to build with the defaults.
