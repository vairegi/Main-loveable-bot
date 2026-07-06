CREATE OR REPLACE FUNCTION public.is_telegram_bot_request()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  WITH request_headers AS (
    SELECT CASE
      WHEN current_setting('request.headers', true) ~ '^\s*\{'
        THEN current_setting('request.headers', true)::jsonb
      ELSE '{}'::jsonb
    END AS headers
  )
  SELECT encode(
    extensions.digest(
      coalesce(
        headers ->> 'x-telegram-bot-secret',
        headers ->> 'X-Telegram-Bot-Secret',
        ''
      ),
      'sha256'
    ),
    'hex'
  ) = 'd7df03dfde75c65fc4260b38ee4bc4d7881e7b6096a8c9a43ea1b57c2296d057'
  FROM request_headers;
$$;

REVOKE ALL ON FUNCTION public.is_telegram_bot_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_telegram_bot_request() TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.admins TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_settings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channels TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.activity_log TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_updates TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.activity_log_id_seq TO anon;

DROP POLICY IF EXISTS "Telegram bot backend can manage admins" ON public.admins;
CREATE POLICY "Telegram bot backend can manage admins"
ON public.admins
FOR ALL
TO anon
USING (public.is_telegram_bot_request())
WITH CHECK (public.is_telegram_bot_request());

DROP POLICY IF EXISTS "Telegram bot backend can manage settings" ON public.bot_settings;
CREATE POLICY "Telegram bot backend can manage settings"
ON public.bot_settings
FOR ALL
TO anon
USING (public.is_telegram_bot_request())
WITH CHECK (public.is_telegram_bot_request());

DROP POLICY IF EXISTS "Telegram bot backend can manage channels" ON public.channels;
CREATE POLICY "Telegram bot backend can manage channels"
ON public.channels
FOR ALL
TO anon
USING (public.is_telegram_bot_request())
WITH CHECK (public.is_telegram_bot_request());

DROP POLICY IF EXISTS "Telegram bot backend can manage activity logs" ON public.activity_log;
CREATE POLICY "Telegram bot backend can manage activity logs"
ON public.activity_log
FOR ALL
TO anon
USING (public.is_telegram_bot_request())
WITH CHECK (public.is_telegram_bot_request());

DROP POLICY IF EXISTS "Telegram bot backend can manage update ids" ON public.telegram_updates;
CREATE POLICY "Telegram bot backend can manage update ids"
ON public.telegram_updates
FOR ALL
TO anon
USING (public.is_telegram_bot_request())
WITH CHECK (public.is_telegram_bot_request());