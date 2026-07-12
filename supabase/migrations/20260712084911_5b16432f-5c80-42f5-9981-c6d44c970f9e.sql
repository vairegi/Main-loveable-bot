
-- Role enum + user_roles
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Favorites (Telegram user favoriting posts)
CREATE TABLE public.favorites (
  user_id bigint NOT NULL,
  post_id bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
GRANT ALL ON public.favorites TO service_role;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bot only" ON public.favorites FOR ALL USING (public.is_telegram_bot_request()) WITH CHECK (public.is_telegram_bot_request());
CREATE INDEX favorites_user_idx ON public.favorites(user_id, created_at DESC);

-- Ratings
CREATE TABLE public.post_ratings (
  post_id bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id bigint NOT NULL,
  rating smallint NOT NULL CHECK (rating IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
GRANT ALL ON public.post_ratings TO service_role;
ALTER TABLE public.post_ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bot only" ON public.post_ratings FOR ALL USING (public.is_telegram_bot_request()) WITH CHECK (public.is_telegram_bot_request());
CREATE INDEX post_ratings_post_idx ON public.post_ratings(post_id);

-- One-time /linkweb tokens
CREATE TABLE public.telegram_link_tokens (
  token text PRIMARY KEY,
  telegram_user_id bigint NOT NULL,
  telegram_username text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.telegram_link_tokens TO authenticated;
GRANT ALL ON public.telegram_link_tokens TO service_role;
ALTER TABLE public.telegram_link_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated can consume" ON public.telegram_link_tokens FOR SELECT TO authenticated USING (true);

-- Web-to-Telegram identity link
CREATE TABLE public.telegram_web_links (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.telegram_web_links TO authenticated;
GRANT ALL ON public.telegram_web_links TO service_role;
ALTER TABLE public.telegram_web_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user sees own link" ON public.telegram_web_links FOR SELECT TO authenticated USING (auth.uid() = auth_user_id);

-- has_role: true if explicit user_roles row OR user is linked to a Telegram admin
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
    OR (
      _role = 'admin'::public.app_role
      AND EXISTS (
        SELECT 1
        FROM public.telegram_web_links l
        JOIN public.admins a ON a.telegram_user_id = l.telegram_user_id
        WHERE l.auth_user_id = _user_id
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
