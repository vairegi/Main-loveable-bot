GRANT ALL ON public.admins TO service_role;
GRANT ALL ON public.bot_settings TO service_role;
GRANT ALL ON public.channels TO service_role;
GRANT ALL ON public.activity_log TO service_role;
GRANT ALL ON public.telegram_updates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.activity_log_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.bootstrap_telegram_super_admin(
  _telegram_user_id bigint,
  _username text,
  _first_name text,
  _webhook_secret text
)
RETURNS public.admins
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _expected_hash constant text := 'd7df03dfde75c65fc4260b38ee4bc4d7881e7b6096a8c9a43ea1b57c2296d057';
  _admin_count integer;
  _row public.admins;
BEGIN
  IF _telegram_user_id IS NULL OR _telegram_user_id <= 0 THEN
    RAISE EXCEPTION 'Invalid Telegram user id';
  END IF;

  IF encode(digest(coalesce(_webhook_secret, ''), 'sha256'), 'hex') <> _expected_hash THEN
    RAISE EXCEPTION 'Invalid bot bootstrap secret';
  END IF;

  SELECT count(*) INTO _admin_count FROM public.admins;
  IF _admin_count > 0 THEN
    SELECT * INTO _row
    FROM public.admins
    WHERE telegram_user_id = _telegram_user_id;

    IF _row.telegram_user_id IS NULL THEN
      RAISE EXCEPTION 'Admin bootstrap is already complete';
    END IF;

    RETURN _row;
  END IF;

  INSERT INTO public.admins (telegram_user_id, username, first_name, is_super_admin, added_by)
  VALUES (_telegram_user_id, _username, _first_name, true, _telegram_user_id)
  ON CONFLICT (telegram_user_id) DO UPDATE
    SET username = excluded.username,
        first_name = excluded.first_name,
        is_super_admin = true,
        added_by = excluded.added_by
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_telegram_super_admin(bigint, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bootstrap_telegram_super_admin(bigint, text, text, text) TO service_role;