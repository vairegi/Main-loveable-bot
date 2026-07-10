CREATE TABLE IF NOT EXISTS public.backup_failures (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT NOT NULL,
  backup_chat_id BIGINT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, backup_chat_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_failures TO authenticated;
GRANT ALL ON public.backup_failures TO service_role;

ALTER TABLE public.backup_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bot manages backup_failures"
ON public.backup_failures FOR ALL
USING (public.is_telegram_bot_request())
WITH CHECK (public.is_telegram_bot_request());
