
CREATE TABLE public.broadcast_jobs (
  id BIGSERIAL PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('text','forward')),
  payload_text TEXT,
  source_chat_id BIGINT,
  source_message_id BIGINT,
  initiator_chat_id BIGINT NOT NULL,
  initiator_user_id BIGINT NOT NULL,
  initiator_username TEXT,
  cursor_user_id BIGINT NOT NULL DEFAULT 0,
  total_ok INT NOT NULL DEFAULT 0,
  total_failed INT NOT NULL DEFAULT 0,
  blocked_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_samples JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  last_tick_at TIMESTAMPTZ
);

CREATE INDEX idx_broadcast_jobs_status ON public.broadcast_jobs(status, id);

GRANT ALL ON public.broadcast_jobs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.broadcast_jobs_id_seq TO service_role;

ALTER TABLE public.broadcast_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bot access broadcast_jobs"
  ON public.broadcast_jobs
  FOR ALL
  USING (public.is_telegram_bot_request())
  WITH CHECK (public.is_telegram_bot_request());
