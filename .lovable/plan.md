You picked **1, 2, 5, 7, 11, 13, 14, 16, 17, 18, 20**. Here's how I'd sequence them so each phase is independently useful and testable.

## Phase 1 — Performance + safety (low risk, high ROI)

**#1 Fix slow backup scanner**
- Rewrite `scanDatabaseToBackups` in `src/lib/bot/backups.ts` from `OFFSET` pagination to keyset: `WHERE id > :last_id ORDER BY id LIMIT N`.
- Add index `posts(id)` is already the PK, so no new index needed; verify EXPLAIN.

**#2 Cache `bot_settings` per request**
- Add a tiny in-memory cache keyed by `key` inside `src/lib/bot/db.ts` (or a new `settings.ts`), scoped to one webhook invocation (Map cleared per request via the dispatcher).
- Replace all direct `bot_settings` reads with `getSetting(db, key)`.

**#20 Confirm-before-destroy**
- Wrap `/reset`, `/resetall`, `/removebackup` handlers with a two-step inline-keyboard prompt (`Yes, wipe` / `Cancel`). Reuse the existing callback router.
- Store the pending destructive action in `search_sessions`-style row keyed by `user_id + action`, expires after 60s.

## Phase 2 — New commands (isolated additions)

**#5 `/stats` upgrade** — aggregate query over `bot_users`, `posts`, `activity_log`, `backup_failures`:
- DAU/WAU/MAU, posts published today/7d, top 10 fetched posts, backup lag (max age of un-backed-up post), failed-broadcast count.

**#7 `/duplicates`** — group `posts` by normalized caption hash and by `media->>0->>'file_unique_id'`; list top N groups with post ids. Admin-only.

**#18 `/doctor`** — self-check:
- Webhook info from Telegram getWebhookInfo
- DB roundtrip (`select 1`)
- Main channel test (`getChat` on each `channels` row where role='main')
- Backup channel test (same for role='backup')
- Drip cron last-run age (from `bot_settings.drip_last_run`)
- Auto-delete queue depth

**#11 Better `/search` pagination**
- Extend `search_sessions.hits` to hold all results, add `page` field.
- Inline keyboard: `⬅ Prev  ·  1/5  ·  Next ➡` alongside checkboxes.
- Callback data: `search:page:<session_id>:<n>`.

## Phase 3 — User-facing features + ops

**#13 Favorites**
- New table `favorites(user_id, post_id, created_at, PRIMARY KEY(user_id, post_id))` with RLS + grants.
- Add ❤️ button to every published-to-user post; toggle via callback `fav:toggle:<post_id>`.
- `/favs` command lists their saved posts (paginated).

**#14 Rating**
- New table `post_ratings(post_id, user_id, rating smallint, created_at, PRIMARY KEY(post_id, user_id))`.
- 👍 / 👎 buttons on posts, callback `rate:<post_id>:<+1|-1>`.
- Aggregate score shown to admins in `/find <id>` and `/stats`.

**#16 Health endpoint**
- New public route `src/routes/api/public/health.ts` returning JSON:
  ```
  { ok, webhook_lag_ms, last_backup_age_s, pending_deletions, backup_failures, updated_at }
  ```
- No auth (safe read-only aggregates, no PII).

**#17 Admin web page at `/admin`**
- Route `src/routes/_authenticated/admin.tsx` gated by the managed auth layout.
- Add a `has_role` check via `requireSupabaseAuth` server fn — only Telegram admins linked to a Supabase user can view.
- Tabs: **Activity log**, **Bot users**, **Posts**, **Backup failures**. Simple sortable tables + search box. No mutations in v1 — read-only viewer.
- Requires the admin to sign into the web app with the email they register via a new bot command `/linkweb <email>` (sends a magic-link tie-up). If you'd rather skip web auth entirely, I can gate `/admin` behind a shared password in Phase 3 — say the word.

## Technical notes

- All new tables get `GRANT` + RLS + policies in the same migration (`authenticated` + `service_role`, no `anon`).
- New callbacks (`fav:*`, `rate:*`, `search:page:*`, `confirm:*`) route through the existing `handleSearchCallback` dispatcher — I'll refactor it into a small router if it grows past ~4 prefixes.
- Every new command registered in `src/lib/bot/commands.ts` with admin/super-admin flags as appropriate.

## Suggested ship order

Phase 1 first (one turn) → verify in preview → Phase 2 (one turn) → Phase 3 (one or two turns depending on how you want #17's auth).

**One decision I need from you before Phase 3:** for the `/admin` web page (#17), do you want (a) full Supabase magic-link auth tied to Telegram admin IDs, or (b) a simpler shared-password gate? (a) is more work but proper; (b) ships in 15 minutes.

Reply "go" to start Phase 1, or tell me to reorder/drop anything.