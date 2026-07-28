-- Explicit deny-by-default policies for the private backup buckets.
-- service_role bypasses RLS, so bot/export jobs keep working.

DROP POLICY IF EXISTS "Admins can read backup files" ON storage.objects;
DROP POLICY IF EXISTS "Admins can upload backup files" ON storage.objects;
DROP POLICY IF EXISTS "Admins can update backup files" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete backup files" ON storage.objects;

CREATE POLICY "Admins can read backup files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id IN ('db-backups', 'database_export_25_07_26')
  AND public.has_role(auth.uid(), 'admin'::public.app_role)
);

CREATE POLICY "Admins can upload backup files"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id IN ('db-backups', 'database_export_25_07_26')
  AND public.has_role(auth.uid(), 'admin'::public.app_role)
);

CREATE POLICY "Admins can update backup files"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id IN ('db-backups', 'database_export_25_07_26')
  AND public.has_role(auth.uid(), 'admin'::public.app_role)
)
WITH CHECK (
  bucket_id IN ('db-backups', 'database_export_25_07_26')
  AND public.has_role(auth.uid(), 'admin'::public.app_role)
);

CREATE POLICY "Admins can delete backup files"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id IN ('db-backups', 'database_export_25_07_26')
  AND public.has_role(auth.uid(), 'admin'::public.app_role)
);