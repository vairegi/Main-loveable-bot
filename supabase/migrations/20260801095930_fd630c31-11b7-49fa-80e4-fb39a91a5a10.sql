insert into public.bot_settings (key, value, updated_at)
values ('caption_template', jsonb_build_object('text', '{caption}

[ @Doujinshi_adults ]'), now())
on conflict (key) do update set value = excluded.value, updated_at = now();