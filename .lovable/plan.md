# Plan — engagement, related posts, health, audit, warn

Big batch. A few ❓ inline — reply "go" to build with defaults, or override.

## 1. User engagement (all user-facing)

- **/streak** — daily fetch streak. Increments when user fetches at least 1 file in a UTC day; resets if they miss a day. Shows current streak, longest streak, and next milestone.
- **/referral** — each user gets a unique deep link `t.me/<bot>?start=ref_<code>`. When a new user hits `/start ref_<code>`, we credit the referrer. Reward: **+5 shortener-free files per successful referral** (bumps `sh_files_used` down / grants a bonus counter). Shows: your code, invite link, total referrals, bonus files remaining.
  - ❓ Reward = 5 free files per referral? (default yes)
- **/notify `#tag`** — subscribe to a hashtag. When a new post is posted to a main channel whose caption contains that tag, bot DMs the subscriber with a deep link. `/notify` (no args) lists subscriptions. `/unnotify #tag` removes one. Cap 10 tags per user.
- **/mystats** — personal card: files fetched (all-time / 7d / today), favs count, referrals, streak, rank on 30d leaderboard, join date.

New tables: `user_streaks(user_id pk, current, longest, last_fetch_day)`, `referrals(referrer_id, referee_id pk, created_at)`, `referral_bonuses(user_id pk, bonus_files_remaining)`, `tag_subscriptions(user_id, tag, created_at, pk(user_id, tag))`.

## 2. Related posts under each file

When a user gets a file via Get File, append **"🔎 Related"** inline buttons (up to 4) under the delivered media. Related = posts sharing ≥1 hashtag with the current post's caption, most recent first, only posted-to-main-channel ones. Each button = a deep link to fetch that related file.

- ❓ Show related on **every** delivery, or only when caption has hashtags? (default: only when hashtags exist — otherwise no buttons)
- ❓ Count: 4 related buttons max in a 2×2 grid? (default yes)

No new table needed — reuses caption ilike matching from `/similar`. To make it fast on hot paths, I'll add a GIN trigram index on `posts.caption`.

## 3. /health (admin)

Telegram command that mirrors the existing `/api/public/health` endpoint but formatted for chat. Shows: pending_deletions (total + due), backup_failures, last_backup_age, last_post_age, drip_last_run_age, broadcast queue depth, scheduled_posts due, cron schedule sanity (drip + autodelete + broadcast + backup last run timestamps from `cron.job_run_details`). One command, one message, color-coded with ✅/⚠️/❌ per row.

## 4. Audit log (admin)

Separate from `activity_log` (which tracks user actions). New `admin_audit(id, admin_id, action, target, details jsonb, created_at)`. Every admin-only command that mutates state writes a row: bans, unbans, warns, /addadmin, /removeadmin, /shortener config changes, /dltbackup, /resetbackup, /undoresetbackup, /postlater, /broadcast, /broadcastlater, /cmdautodelete, /autodelete, drip config, /mpost, /dpost.

- **/audit `[n]`** — admin command, last N audit entries (default 20, max 100), same compact 2-line format as /activity.
- ❓ Also surface it on the web admin dashboard as a new "Audit" tab? (default yes)

## 5. /warn

Admin-only. `/warn <user_id|@username> [reason]`. Sends a formal warning DM to the user ("⚠️ Warning from admins: <reason>"), increments a warn counter, and logs to audit + activity_log. 

- **3 warns = auto-ban** with reason "3 warnings reached".
- **/warns `<user_id>`** — list a user's warnings.
- **/unwarn `<user_id>`** — clear all warnings for a user.

New table: `warnings(id, user_id, admin_id, reason, created_at)`.

## Files touched

- New: `src/lib/bot/engagement.ts` (streak/referral/notify/mystats helpers), `src/lib/bot/related.ts` (related-posts query + keyboard), `src/lib/bot/audit.ts` (writeAudit helper), `src/lib/bot/warnings.ts`.
- `src/lib/bot/commands.ts` — register /streak /referral /notify /unnotify /mystats /health /audit /warn /warns /unwarn; call `writeAudit` inside every mutating admin command; call `bumpStreak` inside `deliverFileByCode`; attach related keyboard after delivery.
- `src/lib/bot/command-catalog.ts` — new entries (per project rule).
- `src/routes/api/public/telegram/webhook.ts` — handle `start=ref_<code>` in /start payload; route new callback data if related buttons use callbacks (they won't — pure deep links).
- `src/routes/_authenticated/admin.tsx` — new "Audit" tab (if ❓4 = yes).
- One Supabase migration for the 5 new tables + GRANTs + RLS + trigram index on `posts.caption`.

## ❓ Please confirm before I build

1. Referral reward = **+5 free files** per invite? (default yes)
2. Related buttons: **only when caption has hashtags**, 2×2 grid? (default yes)
3. Audit tab on web admin dashboard too? (default yes)

Reply "go" for defaults, or override any of the three.
