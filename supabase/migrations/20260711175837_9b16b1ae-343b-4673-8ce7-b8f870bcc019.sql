
CREATE TABLE public.search_sessions (
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
);

GRANT ALL ON public.search_sessions TO service_role;
ALTER TABLE public.search_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: only service role (the bot server) accesses this table.
