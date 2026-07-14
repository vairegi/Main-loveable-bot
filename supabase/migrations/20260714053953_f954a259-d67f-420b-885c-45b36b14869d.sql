REVOKE EXECUTE ON FUNCTION public.get_missing_backup_posts(bigint, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_backup_progress_counts(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_missing_backup_posts(bigint, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_backup_progress_counts(bigint, integer) TO service_role;