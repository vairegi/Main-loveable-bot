
CREATE TABLE public.bot_users (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_count INT NOT NULL DEFAULT 0,
  banned BOOLEAN NOT NULL DEFAULT false,
  banned_reason TEXT,
  banned_at TIMESTAMPTZ,
  rate_window_started_at TIMESTAMPTZ,
  rate_window_count INT NOT NULL DEFAULT 0
);
GRANT ALL ON public.bot_users TO service_role;
ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bot only" ON public.bot_users FOR ALL USING (public.is_telegram_bot_request()) WITH CHECK (public.is_telegram_bot_request());

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS fetch_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bot_users_last_seen ON public.bot_users (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_posts_fetch_count ON public.posts (fetch_count DESC);
