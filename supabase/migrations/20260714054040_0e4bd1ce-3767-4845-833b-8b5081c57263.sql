DROP FUNCTION IF EXISTS public.get_missing_backup_posts(bigint, integer, integer);

CREATE OR REPLACE FUNCTION public.get_missing_backup_posts(
  _backup_chat_id bigint,
  _max_failed_attempts integer DEFAULT 3,
  _limit integer DEFAULT 500,
  _after_post_id bigint DEFAULT 0
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
  WHERE p.id > _after_post_id
    AND NOT EXISTS (
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

REVOKE EXECUTE ON FUNCTION public.get_missing_backup_posts(bigint, integer, integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_missing_backup_posts(bigint, integer, integer, bigint) TO service_role;