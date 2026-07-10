
CREATE TABLE public.pending_deletions (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  delete_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pending_deletions_delete_at ON public.pending_deletions (delete_at);
GRANT ALL ON public.pending_deletions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pending_deletions_id_seq TO service_role;
ALTER TABLE public.pending_deletions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Bot manages pending_deletions" ON public.pending_deletions
  FOR ALL TO public USING (public.is_telegram_bot_request()) WITH CHECK (public.is_telegram_bot_request());

CREATE TABLE public.fsub_satisfied (
  user_id BIGINT NOT NULL,
  channel_chat_id BIGINT NOT NULL,
  satisfied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_chat_id)
);
GRANT ALL ON public.fsub_satisfied TO service_role;
ALTER TABLE public.fsub_satisfied ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Bot manages fsub_satisfied" ON public.fsub_satisfied
  FOR ALL TO public USING (public.is_telegram_bot_request()) WITH CHECK (public.is_telegram_bot_request());
