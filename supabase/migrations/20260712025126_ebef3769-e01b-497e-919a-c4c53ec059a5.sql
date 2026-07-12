CREATE TABLE public.deleted_posts (
  id BIGSERIAL PRIMARY KEY,
  original_post_id BIGINT NOT NULL,
  code TEXT NOT NULL,
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  caption TEXT,
  media JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_group_id TEXT,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  created_by BIGINT,
  original_created_at TIMESTAMPTZ,
  original_posted_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by BIGINT
);

CREATE INDEX deleted_posts_code_idx ON public.deleted_posts(code);
CREATE INDEX deleted_posts_deleted_at_idx ON public.deleted_posts(deleted_at DESC);

GRANT ALL ON public.deleted_posts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deleted_posts TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.deleted_posts_id_seq TO anon, authenticated, service_role;

ALTER TABLE public.deleted_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Telegram bot can manage deleted posts"
ON public.deleted_posts
FOR ALL
USING (public.is_telegram_bot_request())
WITH CHECK (public.is_telegram_bot_request());