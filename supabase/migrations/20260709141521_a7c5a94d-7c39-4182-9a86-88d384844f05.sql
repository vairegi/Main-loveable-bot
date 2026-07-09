CREATE TABLE public.backup_copies (
  id bigserial PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  backup_chat_id bigint NOT NULL,
  backup_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, backup_chat_id)
);

CREATE INDEX idx_backup_copies_chat ON public.backup_copies (backup_chat_id);
CREATE INDEX idx_backup_copies_post ON public.backup_copies (post_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_copies TO authenticated;
GRANT ALL ON public.backup_copies TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.backup_copies_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.backup_copies_id_seq TO service_role;

ALTER TABLE public.backup_copies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Telegram bot backend can manage backup_copies"
  ON public.backup_copies
  FOR ALL
  TO anon
  USING (is_telegram_bot_request())
  WITH CHECK (is_telegram_bot_request());
