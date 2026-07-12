// Public health endpoint — no auth. Returns lightweight aggregates for monitoring.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const { getAdminDb } = await import("@/lib/bot/db");
        const db = getAdminDb();

        const now = Date.now();
        const [pending, failures, lastBackup, lastPost, dripLast] = await Promise.all([
          db.from("pending_deletions").select("id", { count: "exact", head: true }),
          db.from("backup_failures").select("id", { count: "exact", head: true }),
          db.from("backup_copies").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
          db.from("posts").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
          db.from("bot_settings").select("value").eq("key", "drip_last_run").maybeSingle(),
        ]);

        const lastBackupTs = lastBackup.data?.created_at ? new Date(lastBackup.data.created_at).getTime() : null;
        const lastPostTs = lastPost.data?.created_at ? new Date(lastPost.data.created_at).getTime() : null;
        const dripLastTs = (dripLast.data?.value as any)?.at
          ? new Date((dripLast.data!.value as any).at).getTime()
          : null;

        const body = {
          ok: true,
          pending_deletions: pending.count ?? 0,
          backup_failures: failures.count ?? 0,
          last_backup_age_s: lastBackupTs ? Math.floor((now - lastBackupTs) / 1000) : null,
          last_post_age_s: lastPostTs ? Math.floor((now - lastPostTs) / 1000) : null,
          drip_last_run_age_s: dripLastTs ? Math.floor((now - dripLastTs) / 1000) : null,
          updated_at: new Date().toISOString(),
        };

        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
