DROP POLICY IF EXISTS "authenticated can consume" ON public.telegram_link_tokens;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.telegram_link_tokens FROM authenticated, anon;