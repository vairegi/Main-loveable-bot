ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS extra_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS media_group_id text;

-- Fast lookup for the drip scheduler (oldest queued first)
CREATE INDEX IF NOT EXISTS posts_queue_idx
  ON public.posts (created_at)
  WHERE posted_at IS NULL;

-- Fast lookup for attaching file-only messages to the most recent captioned post in the same channel
CREATE INDEX IF NOT EXISTS posts_source_recent_idx
  ON public.posts (source_chat_id, created_at DESC);
