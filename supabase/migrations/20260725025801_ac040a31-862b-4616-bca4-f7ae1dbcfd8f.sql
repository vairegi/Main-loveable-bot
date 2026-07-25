
-- 1. Scheduled posts (either by existing post code, or a one-shot from replied media)
CREATE TABLE public.scheduled_posts (
  id BIGSERIAL PRIMARY KEY,
  scheduled_for TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code','oneshot')),
  post_code TEXT,
  media JSONB,
  caption TEXT,
  target_chat_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','cancelled')),
  last_error TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
GRANT ALL ON public.scheduled_posts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.scheduled_posts_id_seq TO service_role;
ALTER TABLE public.scheduled_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bot-only access to scheduled_posts"
  ON public.scheduled_posts FOR ALL
  USING (public.is_telegram_bot_request())
  WITH CHECK (public.is_telegram_bot_request());

CREATE INDEX idx_scheduled_posts_due
  ON public.scheduled_posts (scheduled_for)
  WHERE status = 'pending';

-- 2. Scheduled broadcasts: add scheduled_for column to broadcast_jobs
ALTER TABLE public.broadcast_jobs
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_scheduled
  ON public.broadcast_jobs (scheduled_for)
  WHERE status = 'scheduled';

-- 3. Realtime for activity_log (for live-tail in web admin)
ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_log;
