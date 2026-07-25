
ALTER TABLE public.bot_users
  ADD COLUMN IF NOT EXISTS sh_verified_until timestamptz,
  ADD COLUMN IF NOT EXISTS sh_files_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sh_pending_token text,
  ADD COLUMN IF NOT EXISTS sh_pending_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS sh_pending_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS sh_pending_code text,
  ADD COLUMN IF NOT EXISTS sh_bypass_count integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS bot_users_sh_pending_token_idx
  ON public.bot_users (sh_pending_token)
  WHERE sh_pending_token IS NOT NULL;
