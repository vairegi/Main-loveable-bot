GRANT ALL ON public.admins TO service_role;
GRANT ALL ON public.bot_settings TO service_role;
GRANT ALL ON public.channels TO service_role;
GRANT ALL ON public.activity_log TO service_role;
GRANT ALL ON public.telegram_updates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.activity_log_id_seq TO service_role;