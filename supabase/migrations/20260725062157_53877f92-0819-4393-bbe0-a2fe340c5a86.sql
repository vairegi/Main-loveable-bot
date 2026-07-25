
-- pg_trgm for fast caption ilike (similar / related)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS posts_caption_trgm_idx ON public.posts USING gin (caption gin_trgm_ops);

-- user_streaks
CREATE TABLE IF NOT EXISTS public.user_streaks (
  user_id bigint PRIMARY KEY,
  current_streak int NOT NULL DEFAULT 0,
  longest_streak int NOT NULL DEFAULT 0,
  last_fetch_day date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.user_streaks TO service_role;
ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "streaks_service_all" ON public.user_streaks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- referrals
CREATE TABLE IF NOT EXISTS public.referrals (
  referee_id bigint PRIMARY KEY,
  referrer_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON public.referrals(referrer_id);
GRANT ALL ON public.referrals TO service_role;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "referrals_service_all" ON public.referrals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- referral_bonuses
CREATE TABLE IF NOT EXISTS public.referral_bonuses (
  user_id bigint PRIMARY KEY,
  bonus_files_remaining int NOT NULL DEFAULT 0,
  total_earned int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.referral_bonuses TO service_role;
ALTER TABLE public.referral_bonuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "refbonus_service_all" ON public.referral_bonuses FOR ALL TO service_role USING (true) WITH CHECK (true);

-- tag_subscriptions
CREATE TABLE IF NOT EXISTS public.tag_subscriptions (
  user_id bigint NOT NULL,
  tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX IF NOT EXISTS tag_subs_tag_idx ON public.tag_subscriptions(tag);
GRANT ALL ON public.tag_subscriptions TO service_role;
ALTER TABLE public.tag_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tagsubs_service_all" ON public.tag_subscriptions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- warnings
CREATE TABLE IF NOT EXISTS public.warnings (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  admin_id bigint NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warnings_user_idx ON public.warnings(user_id);
GRANT ALL ON public.warnings TO service_role;
ALTER TABLE public.warnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warnings_service_all" ON public.warnings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- admin_audit
CREATE TABLE IF NOT EXISTS public.admin_audit (
  id bigserial PRIMARY KEY,
  admin_id bigint NOT NULL,
  admin_username text,
  action text NOT NULL,
  target text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON public.admin_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_admin_idx ON public.admin_audit(admin_id);
GRANT ALL ON public.admin_audit TO service_role;
-- Allow authenticated admins to read via web dashboard (has_role check on client side + RLS)
GRANT SELECT ON public.admin_audit TO authenticated;
ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_service_all" ON public.admin_audit FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "audit_admin_read" ON public.admin_audit FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Enable realtime for admin_audit (matches pattern with activity_log)
ALTER TABLE public.admin_audit REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_audit;
