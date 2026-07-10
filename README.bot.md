# Telegram File Bot — Setup Guide

Step-by-step instructions to install, configure, and run this bot from the downloaded zip.

The bot is built on **TanStack Start** (React 19 + Vite 7) and uses **Supabase** for the database and **Telegram Bot API** via the Lovable connector gateway. It runs as a serverless app (Cloudflare Workers / edge runtime) — there is no long-lived Node server.

---

## 1. Prerequisites

- **Node.js 20+** and **Bun** (or npm/pnpm). Install Bun: `curl -fsSL https://bun.sh/install | bash`
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- A **Supabase project** (or a Lovable Cloud project — same backend)
- A **Lovable API key** if you want to keep using the connector gateway. If you'd rather call Telegram directly, see §7.

---

## 2. Unzip and install dependencies

```bash
unzip telegram-bot-files.zip -d telegram-bot
cd telegram-bot
bun install     # or: npm install
```

> The zip contains only bot source files. You need to place them inside a fresh TanStack Start project (see §3) — or clone the original repo and drop these files in.

---

## 3. Project scaffold

The bot files assume this layout:

```
src/
  lib/bot/                    ← core bot logic
  integrations/supabase/      ← DB clients
  routes/
    api/public/telegram/      ← Telegram webhook
    api/public/hooks/         ← cron endpoints (drip, autodelete, backup)
scripts/backfill-history.mjs  ← optional history backfill
supabase/config.toml
package.json
```

If you don't already have a TanStack Start scaffold, create one:

```bash
bunx create-tsrouter-app@latest my-bot --template file-router --tailwind
```

Then copy the unzipped `src/`, `scripts/`, and `supabase/` folders into it.

---

## 4. Create the database schema

Run these migrations in your Supabase SQL editor (or via `supabase db push`).

Required tables:

- `admins` — bot admins (telegram_user_id, is_super_admin)
- `bot_users` — end users, rate-limit state, ban list
- `channels` — force-sub / database / index channels (role enum)
- `fsub_satisfied` — join-request cache
- `files` — file catalog (post_id, message_id, caption)
- `posts` — published/queued posts
- `pending_deletions` — autodelete TTL queue
- `telegram_updates` — idempotency for webhook deliveries
- `bot_settings` — key/value config (drip schedule, etc.)
- `audit_log` — admin action log

Each `CREATE TABLE public.<name>` **must** be followed by `GRANT` statements + `ENABLE ROW LEVEL SECURITY` + policies. Also create the RPC:

```sql
create or replace function public.is_telegram_bot_request()
returns boolean language sql stable
set search_path to 'public', 'extensions'
as $$
  select encode(extensions.digest(
    coalesce(current_setting('request.headers', true)::jsonb ->> 'x-telegram-bot-secret', ''),
    'sha256'), 'hex') = '<SHA256_OF_YOUR_WEBHOOK_SECRET>';
$$;
```

The webhook secret hash is `sha256("telegram-webhook:" + TELEGRAM_API_KEY)` in hex.

---

## 5. Configure environment variables

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

Required variables:

| Variable | Where to get it |
|---|---|
| `VITE_SUPABASE_URL` / `SUPABASE_URL` | Supabase project settings → API |
| `VITE_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_PUBLISHABLE_KEY` | Supabase → API → `anon`/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API → `service_role` key (**server-only**) |
| `TELEGRAM_API_KEY` | Either your BotFather token, or the Lovable Telegram connector key |
| `LOVABLE_API_KEY` | Lovable dashboard (only if using the connector gateway) |

---

## 6. Run locally

```bash
bun run dev
```

Vite serves the app at `http://localhost:8080`. The webhook endpoint is `POST /api/public/telegram/webhook`.

Telegram requires HTTPS, so expose your local server with a tunnel:

```bash
# ngrok
ngrok http 8080
# or cloudflared
cloudflared tunnel --url http://localhost:8080
```

---

## 7. Register the webhook with Telegram

Compute the derived secret and register:

```bash
export TELEGRAM_API_KEY="<your-key>"
export WEBHOOK_URL="https://your-tunnel-or-domain/api/public/telegram/webhook"

SECRET=$(node -e "console.log(require('crypto').createHash('sha256').update('telegram-webhook:'+process.env.TELEGRAM_API_KEY).digest('base64url'))")

# Option A — via Lovable connector gateway (default in this codebase):
curl -sS https://connector-gateway.lovable.dev/telegram/setWebhook \
  -H "Authorization: Bearer $LOVABLE_API_KEY" \
  -H "X-Connection-Api-Key: $TELEGRAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK_URL\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\",\"edited_message\",\"channel_post\",\"chat_join_request\"]}"

# Option B — direct to Telegram (replace src/lib/bot/telegram.ts to call
# https://api.telegram.org/bot<BOT_TOKEN>/... instead of the gateway):
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK_URL\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\",\"edited_message\",\"channel_post\",\"chat_join_request\"]}"
```

Verify:

```bash
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

---

## 8. Bootstrap the first admin

Message the bot with `/start`, then run this SQL to promote yourself:

```sql
insert into public.admins (telegram_user_id, username, first_name, is_super_admin, added_by)
values (<your-telegram-user-id>, '<username>', '<first-name>', true, <your-telegram-user-id>);
```

Or call the `bootstrap_telegram_super_admin` RPC with your derived webhook secret.

---

## 9. Schedule the cron jobs

Enable `pg_cron` in Supabase and add jobs pointing to your public URL:

```sql
select cron.schedule('drip',        '*/2 * * * *', $$ select net.http_post('https://YOUR_HOST/api/public/hooks/drip') $$);
select cron.schedule('autodelete',  '* * * * *',   $$ select net.http_post('https://YOUR_HOST/api/public/hooks/autodelete') $$);
select cron.schedule('auto-backup', '0 3 * * *',   $$ select net.http_post('https://YOUR_HOST/api/public/hooks/auto-backup') $$);
```

---

## 10. Deploy to production

Any edge/serverless host that runs a TanStack Start build works — Cloudflare Workers, Vercel, Netlify, Lovable Cloud. Build:

```bash
bun run build
```

Then set the env vars from §5 in the host's dashboard and deploy. Re-register the webhook (§7) with the production URL.

---

## Commands

Once running, DM the bot:

- `/start` — greeting + get file by payload
- `/broadcast <text>` — send a message to every user (admin)
- `/broadcast` in reply to a forwarded post — re-forward to every user
- `/addchannel`, `/removechannel`, `/listchannels` — force-sub / database / index channels
- `/ban`, `/unban`, `/users` — user management
- `/setdrip`, `/queue`, `/publish` — post scheduling
- `/backup`, `/restore` — DB backups

See `src/lib/bot/commands.ts` for the full list.

---

## Troubleshooting

- **Webhook returns 401** — the `X-Telegram-Bot-Api-Secret-Token` header doesn't match the derived secret. Re-run §7 with the current `TELEGRAM_API_KEY`.
- **"TELEGRAM_API_KEY is not configured"** — env var missing at runtime. `process.env.*` is server-only; check your host's env config.
- **RLS blocks bot writes** — the service-role client bypasses RLS. Make sure `SUPABASE_SERVICE_ROLE_KEY` is set on the server and every `public.<table>` has explicit GRANTs.
- **Broadcast delivers 0/N** — users must `/start` the bot at least once; blocked users are auto-banned after a 403.
- **Duplicate updates** — normal; `telegram_updates` deduplicates by `update_id`.
