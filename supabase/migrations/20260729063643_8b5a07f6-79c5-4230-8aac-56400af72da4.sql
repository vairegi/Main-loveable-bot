ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS also_fsub boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS also_backup boolean NOT NULL DEFAULT false;