
# Telegram File-Sharing Bot System

Built on Lovable's hosting (no VPS, no SSH). Everything controlled via Telegram commands — no code editing, no config files.

## Tech choices (and why)

- **Telegram Bot API** via Lovable's Telegram connector — you never handle bot tokens directly, gateway auth is automatic.
- **Lovable Cloud (Postgres)** — all state lives in the database: settings, channels, files, users, premium, referrals, logs. Nothing hardcoded.
- **TanStack Start server routes** — one public webhook endpoint per bot. Webhooks (not polling) = instant, no cold starts, scales for free.
- **Runs 24/7 on Lovable's hosting** — auto-restart, no systemd, no server admin.

## Important trade-off vs your original Telethon plan

Bot API bots can't read arbitrary channel history like a userbot. **The management bot must be added as admin to your Database Channel and your Main Channel(s)** so it receives channel-post updates and can post/edit/delete there. That's the standard supported way for automation bots.

## Phased build order

Each phase is fully working and testable before we move on. After every phase I'll walk you through the new commands in plain English.

### Phase 1 — Foundation & Management Bot skeleton
- Enable Lovable Cloud + Telegram connector
- Database tables: `bot_settings`, `admins`, `channels`, `posts`, `activity_log`
- Webhook endpoint `/api/public/telegram/webhook` — verifies Telegram secret, dispatches updates
- Command router with permission checks
- Bootstrap: first user to send `/start` on the bot becomes super-admin
- Commands: `/start`, `/help`, `/whoami`, `/addadmin`, `/removeadmin`, `/listadmins`, `/addchannel`, `/removechannel`, `/listchannels`, `/setlog <channel_id>`
- Activity log channel: every admin action is posted there
- **Test gate:** you can add channels, add admins, and see log entries.

### Phase 2 — Database Channel → Main Channel auto-posting
- Detect new posts in Database Channel (channel_post updates)
- Copy/forward to Main Channel(s) with configurable caption template
- Generate a unique deep-link code per file (`/start abc123` opens the delivery bot)
- Commands: `/setcaption`, `/settemplate`, `/pausePosting`, `/resumePosting`, `/repost <id>`, `/deletepost <id>`
- **Test gate:** posts in DB channel appear in main channel with a "Get File" button.

### Phase 3 — Delivery Bot(s) & file delivery
- Add multiple delivery bots via `/addbot <token>` (stored in DB, webhook auto-registered)
- Load-balance across delivery bots (round-robin, respects Telegram rate limits)
- User sends `/start <code>` → delivery bot sends the file
- Auto-delete delivered files after configurable timer (`/setdeletetimer <minutes>`)
- Commands: `/addbot`, `/removebot`, `/listbots`, `/setdeletetimer`
- **Test gate:** click "Get File" button → delivery bot sends you the file → auto-deletes.

### Phase 4 — Force-subscribe & verification/monetization gate
- Force-subscribe: user must join channel(s) before delivery
- Verification gate: shortener redirect (Linkvertise/AdLinkFly/GPLinks etc.) — user clicks link, completes, comes back with a token → unlocks delivery for N hours
- Commands: `/addforcesub`, `/removeforcesub`, `/setshortener <provider> <api_key>`, `/setverifyduration <hours>`, `/bypass <user_id>`
- **Test gate:** non-premium user must join channels + pass shortener before file arrives.

### Phase 5 — Premium tier
- Premium users skip verification, get instant delivery, no auto-delete
- Commands: `/addpremium <user_id> <days>`, `/removepremium <user_id>`, `/premiumlist`, `/mystatus`
- Payment: manual grant by admin (Telegram Stars / crypto / off-platform — you handle payment, run `/addpremium`)
- **Test gate:** premium users get instant delivery, non-premium go through gate.

### Phase 6 — Broadcasting & user management
- `/broadcast <message>` — send to all users (respects rate limits, reports success/fail count)
- `/broadcastpremium`, `/broadcastfree`
- `/users` stats, `/banuser`, `/unbanuser`
- **Test gate:** broadcast a test message, see delivery report.

### Phase 7 — Referrals & leaderboard
- Every user gets a unique referral link
- Track referrals, reward N days premium after threshold
- Commands: `/setreferralreward <invites> <days>`, `/leaderboard`, `/myreferrals`
- **Test gate:** invite a test account, verify reward triggers.

### Phase 8 — Search, scheduling & analytics
- File search: `/search <query>` (indexed on captions/filenames)
- Scheduled posting: `/schedule <cron> <post_id>`
- Analytics: `/stats`, `/topfiles`, `/topusers`, daily/weekly auto-summary to log channel
- **Test gate:** search returns files, scheduled post fires, stats display correctly.

### Phase 9 — Backups & customization
- Nightly DB backup posted to a private backup channel (`/setbackupchannel`)
- Custom welcome message: `/setwelcome`
- Export/import settings: `/exportsettings`, `/importsettings`

## Technical details (skip if not interested)

- **Storage:** all bot tokens, channel IDs, settings, files metadata in Postgres. Files themselves live in Telegram (we store `file_id`).
- **Webhooks:** each bot has its own path `/api/public/telegram/webhook/<bot_id>`, secured by Telegram's `X-Telegram-Bot-Api-Secret-Token` header (secret derived from bot ID + server secret).
- **Rate limiting:** per-bot queue respecting Telegram's 30 msg/sec global limit.
- **Modularity:** each feature lives in its own module under `src/lib/bot/features/`. Adding a new feature = adding a file, not editing existing ones.
- **Idempotency:** every update stored by `update_id` so Telegram retries don't double-process.

## What I need from you at kickoff (Phase 1)

1. Approve this plan
2. I'll enable Lovable Cloud + connect Telegram — you'll create the **management bot** via [@BotFather](https://t.me/BotFather) and paste the token when the connector prompts
3. Then send `/start` to your bot to claim super-admin

Ready to start Phase 1?
