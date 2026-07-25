# Telegram Bot — Transfer Instructions (for the new Lovable account)

This zip contains the full source of a working Telegram file bot built on **TanStack Start + Lovable Cloud (Supabase) + Telegram connector**. Follow these steps to bring it up in a brand-new Lovable project.

---

## 0. What's inside the zip

```
src/               ← all app code (routes, bot logic, MCP, integrations)
scripts/           ← optional history backfill script
supabase/
  config.toml      ← ⚠️ replace project_id with the NEW project's ref
  migrations/     ← every DB migration (run in order)
public/            ← static assets
package.json, bun.lock, bunfig.toml, tsconfig.json,
vite.config.ts, components.json, eslint.config.js
README.bot.md      ← original setup guide
.env.example       ← documents required env vars
```

---

## 1. Create a fresh Lovable project

1. In the target Lovable account, create a **new blank project** (TanStack Start template).
2. Enable **Lovable Cloud** for that project (Settings → Cloud → Enable).
3. Connect the **Telegram connector** in that project (Settings → Connectors → Telegram → Connect with your BotFather token). This injects `TELEGRAM_API_KEY` and `LOVABLE_API_KEY` automatically.

---

## 2. Give this zip + prompt to the target account's Lovable AI

Attach `telegram-bot-transfer.zip` in the chat, then paste this prompt verbatim:

> I'm importing an existing Telegram bot. The attached zip contains the full source: `src/`, `scripts/`, `supabase/migrations/`, `public/`, and all root config files (`package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `vite.config.ts`, `components.json`, `eslint.config.js`, `.env.example`, `README.bot.md`).
>
> Please do the following in order:
>
> 1. Extract the zip and overwrite the project files. Keep the auto-generated files this project already has (`src/integrations/supabase/client.ts`, `client.server.ts`, `auth-middleware.ts`, `auth-attacher.ts`, `types.ts`, `.env`, `src/routeTree.gen.ts`) — do NOT overwrite those. If a conflict exists between the zipped `client.ts`/`types.ts` and the auto-generated one, keep the auto-generated one.
> 2. Open `supabase/config.toml` and replace the `project_id` value with THIS project's Supabase ref (the one Lovable Cloud provisioned for the new project).
> 3. Run every SQL file in `supabase/migrations/` in filename order against the new Cloud database. They contain the full schema (tables: `admins`, `bot_users`, `channels`, `posts`, `favorites`, `post_ratings`, `user_roles`, `broadcast_jobs`, `backup_copies`, `backup_failures`, `bot_settings`, `pending_deletions`, `telegram_updates`, `telegram_link_tokens`, `telegram_web_links`, `fsub_satisfied`, `activity_log`, `deleted_posts`, `post_copies`, `search_sessions`, `channels`), the `app_role` enum, and the SECURITY DEFINER functions (`has_role`, `is_telegram_bot_request`, `bootstrap_telegram_super_admin`, `get_backup_progress_counts`, `get_missing_backup_posts`). All GRANTs and RLS policies are included.
> 4. Run `bun install`.
> 5. Ensure the following secrets exist for the project (Cloud auto-provisions most): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_API_KEY`, `LOVABLE_API_KEY`. If any is missing, prompt me for it via `add_secret`.
> 6. Publish the project so it gets a stable `project--<id>.lovable.app` URL.
> 7. After publish succeeds, register the Telegram webhook. Compute the secret as `sha256("telegram-webhook:" + TELEGRAM_API_KEY)` in base64url, then call the connector gateway:
>    ```
>    POST https://connector-gateway.lovable.dev/telegram/setWebhook
>    Headers: Authorization: Bearer $LOVABLE_API_KEY
>             X-Connection-Api-Key: $TELEGRAM_API_KEY
>    Body: {
>      "url": "https://project--<NEW_PROJECT_ID>.lovable.app/api/public/telegram/webhook",
>      "secret_token": "<DERIVED_SECRET>",
>      "allowed_updates": ["message","edited_message","channel_post","chat_join_request"]
>    }
>    ```
> 8. Update the `is_telegram_bot_request()` DB function so the hash inside it matches the NEW `TELEGRAM_API_KEY`. The migration writes a specific hash from the old key — replace the hex literal with `sha256("telegram-webhook:" + <new TELEGRAM_API_KEY>)` in hex. Do this via a new migration.
> 9. Bootstrap me as the super-admin: run
>    ```sql
>    INSERT INTO public.admins (telegram_user_id, username, first_name, is_super_admin, added_by)
>    VALUES (<MY_TELEGRAM_USER_ID>, '<my_username>', '<my_first_name>', true, <MY_TELEGRAM_USER_ID>);
>    ```
>    Ask me for my Telegram user id if you don't have it.
> 10. Schedule the three pg_cron jobs against the new URL:
>    ```sql
>    select cron.schedule('drip',        '*/2 * * * *', $$ select net.http_post('https://project--<NEW_ID>.lovable.app/api/public/hooks/drip') $$);
>    select cron.schedule('autodelete',  '* * * * *',   $$ select net.http_post('https://project--<NEW_ID>.lovable.app/api/public/hooks/autodelete') $$);
>    select cron.schedule('auto-backup', '*/1 * * * *', $$ select net.http_post('https://project--<NEW_ID>.lovable.app/api/public/hooks/auto-backup') $$);
>    select cron.schedule('broadcast-every-minute', '* * * * *', $$ select net.http_post('https://project--<NEW_ID>.lovable.app/api/public/hooks/broadcast') $$);
>    ```
> 11. Send `/start` to the bot on Telegram and confirm it replies. If it doesn't, show me the last 20 lines of server-function / route logs.

That's it — the target account's AI can do the rest automatically.

---

## 3. Manual fallback (if the AI needs help)

**Secrets:** All required env vars are documented in `.env.example`. `SUPABASE_*` are auto-provisioned by Lovable Cloud. `TELEGRAM_API_KEY` and `LOVABLE_API_KEY` come from connecting the Telegram connector.

**Webhook secret hash in DB:** The `is_telegram_bot_request()` function contains a hard-coded sha256 hex of the old key. It MUST be updated to match the new `TELEGRAM_API_KEY` or the bot won't be able to write to the DB from webhooks. Compute:
```bash
node -e "console.log(require('crypto').createHash('sha256').update('telegram-webhook:'+process.env.TELEGRAM_API_KEY).digest('hex'))"
```
Then `CREATE OR REPLACE FUNCTION public.is_telegram_bot_request()` with the new hex.

**Bootstrap admin RPC:** The migrations also include `bootstrap_telegram_super_admin(...)` which is gated by the same hash. Simpler to insert the admin row directly (step 9 above).

**Backup channel(s):** The old bot's `channels` and `backup_copies` rows are NOT included (they reference the previous bot's Telegram chats). Re-add channels via `/addchannel` in the new bot. If you also want to move the backup DB rows, export/import the `channels`, `posts`, `favorites`, `bot_users`, `admins`, `user_roles` tables between the two Cloud projects — use the Cloud → Advanced settings → Export data feature on the old project, then insert into the new one.

**Custom domain / URL slug:** After publish, connect your custom domain in Settings → Domains, or ask the AI to rename the Lovable slug.

---

## 4. Verification checklist

- [ ] `/start` in Telegram replies
- [ ] `/help` shows the categorized command list
- [ ] `/stats` returns numbers (means DB is reachable & admin row exists)
- [ ] `/commands` page loads on the published URL
- [ ] pg_cron jobs are visible in `select * from cron.job;`
- [ ] A test post via `/dpost` or `/mpost` reaches the channel

If any step fails, share the error text with the target account's AI — it can debug from logs.
