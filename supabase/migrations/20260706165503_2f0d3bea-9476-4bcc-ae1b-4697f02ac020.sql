
CREATE TABLE public.posts (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  caption TEXT,
  media JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_chat_id, source_message_id)
);
GRANT ALL ON public.posts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.posts_id_seq TO anon, service_role;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Telegram bot backend can manage posts"
  ON public.posts FOR ALL TO anon
  USING (public.is_telegram_bot_request())
  WITH CHECK (public.is_telegram_bot_request());

CREATE TABLE public.post_copies (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  main_chat_id BIGINT NOT NULL,
  main_message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (main_chat_id, main_message_id)
);
CREATE INDEX idx_post_copies_post_id ON public.post_copies(post_id);
GRANT ALL ON public.post_copies TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.post_copies TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.post_copies_id_seq TO anon, service_role;
ALTER TABLE public.post_copies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Telegram bot backend can manage post_copies"
  ON public.post_copies FOR ALL TO anon
  USING (public.is_telegram_bot_request())
  WITH CHECK (public.is_telegram_bot_request());
