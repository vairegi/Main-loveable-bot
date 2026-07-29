ALTER TABLE public.channels ADD COLUMN IF NOT EXISTS also_main boolean NOT NULL DEFAULT false;
UPDATE public.channels SET also_main = true WHERE telegram_chat_id = -1004399640463;