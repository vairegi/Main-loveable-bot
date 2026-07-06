REVOKE ALL ON FUNCTION public.bootstrap_telegram_super_admin(bigint, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_telegram_super_admin(bigint, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.bootstrap_telegram_super_admin(bigint, text, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.bootstrap_telegram_super_admin(bigint, text, text, text) FROM sandbox_exec;
GRANT EXECUTE ON FUNCTION public.bootstrap_telegram_super_admin(bigint, text, text, text) TO service_role;