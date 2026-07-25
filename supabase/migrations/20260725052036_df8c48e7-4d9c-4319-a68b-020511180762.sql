DO $$
BEGIN
  PERFORM cron.unschedule('bot-autodelete-tick');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('autodelete');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'autodelete',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://grow-our-vision.lovable.app/api/public/hooks/autodelete',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);