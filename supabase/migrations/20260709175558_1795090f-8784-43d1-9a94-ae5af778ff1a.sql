SELECT cron.unschedule('auto-backup-every-2min');
SELECT cron.schedule(
  'auto-backup-every-2min',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--63054181-241c-4222-a8c4-6a324a5c7656-dev.lovable.app/api/public/hooks/auto-backup',
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_UliAz1OdS3ITwhrkZ0kibQ_YR9upe2a"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);