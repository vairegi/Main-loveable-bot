CREATE INDEX IF NOT EXISTS idx_backup_copies_chat_post
  ON public.backup_copies (backup_chat_id, post_id);

CREATE INDEX IF NOT EXISTS idx_backup_failures_chat_attempts_post
  ON public.backup_failures (backup_chat_id, attempts, post_id);

CREATE OR REPLACE FUNCTION public.get_missing_backup_posts(
  _backup_chat_id bigint,
  _max_failed_attempts integer DEFAULT 3,
  _limit integer DEFAULT 500
)
RETURNS TABLE (
  id bigint,
  source_chat_id bigint,
  source_message_id bigint,
  extra_files jsonb,
  media jsonb,
  caption text,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.source_chat_id,
    p.source_message_id,
    p.extra_files,
    p.media,
    p.caption,
    p.created_at
  FROM public.posts p
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.backup_copies bc
    WHERE bc.backup_chat_id = _backup_chat_id
      AND bc.post_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.backup_failures bf
    WHERE bf.backup_chat_id = _backup_chat_id
      AND bf.post_id = p.id
      AND bf.attempts >= _max_failed_attempts
  )
  ORDER BY p.id ASC
  LIMIT LEAST(GREATEST(_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.get_backup_progress_counts(
  _backup_chat_id bigint,
  _max_failed_attempts integer DEFAULT 3
)
RETURNS TABLE (
  total_all bigint,
  already_done bigint,
  already_exhausted bigint,
  total_to_do bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH totals AS (
    SELECT count(*)::bigint AS total_all
    FROM public.posts
  ),
  done AS (
    SELECT count(DISTINCT bc.post_id)::bigint AS already_done
    FROM public.backup_copies bc
    WHERE bc.backup_chat_id = _backup_chat_id
  ),
  exhausted AS (
    SELECT count(*)::bigint AS already_exhausted
    FROM public.backup_failures bf
    WHERE bf.backup_chat_id = _backup_chat_id
      AND bf.attempts >= _max_failed_attempts
      AND NOT EXISTS (
        SELECT 1
        FROM public.backup_copies bc
        WHERE bc.backup_chat_id = _backup_chat_id
          AND bc.post_id = bf.post_id
      )
  )
  SELECT
    totals.total_all,
    done.already_done,
    exhausted.already_exhausted,
    GREATEST(totals.total_all - done.already_done - exhausted.already_exhausted, 0)::bigint AS total_to_do
  FROM totals, done, exhausted;
$$;

REVOKE ALL ON FUNCTION public.get_missing_backup_posts(bigint, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_backup_progress_counts(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_missing_backup_posts(bigint, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_backup_progress_counts(bigint, integer) TO service_role;