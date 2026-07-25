// Automatic database export — called daily by pg_cron, but only actually
// exports when the last successful run is older than the configured interval
// (default 2 days). Uploads CSVs to the private db-backups bucket and DMs
// every super-admin a summary with signed download links.
import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_INTERVAL_DAYS = 2;

export const Route = createFileRoute("/api/public/hooks/db-export")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

async function handle(request: Request) {
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  const { getAdminDb } = await import("@/lib/bot/db");
  const { runDatabaseExport, formatExportReport } = await import("@/lib/bot/db-export");
  const { sendMessage } = await import("@/lib/bot/telegram");
  const db = getAdminDb();

  const { data: cfgRow } = await db.from("bot_settings").select("value").eq("key", "db_export").maybeSingle();
  const cfg = ((cfgRow?.value as any) ?? {}) as { enabled?: boolean; interval_days?: number; last_run?: string };
  if (cfg.enabled === false && !force) {
    return Response.json({ ok: true, skipped: "disabled" });
  }

  const intervalDays = Number(cfg.interval_days) > 0 ? Number(cfg.interval_days) : DEFAULT_INTERVAL_DAYS;
  const lastRunMs = cfg.last_run ? new Date(cfg.last_run).getTime() : 0;
  const dueAt = lastRunMs + intervalDays * 86_400_000;
  if (!force && lastRunMs && Date.now() < dueAt) {
    return Response.json({ ok: true, skipped: "not_due", next_run: new Date(dueAt).toISOString() });
  }

  const result = await runDatabaseExport(db);

  await db.from("bot_settings").upsert(
    {
      key: "db_export",
      value: {
        ...cfg,
        enabled: cfg.enabled !== false,
        interval_days: intervalDays,
        last_run: new Date().toISOString(),
        last_folder: result.folder,
        last_rows: result.totalRows,
        last_failed: result.failed,
      },
    },
    { onConflict: "key" },
  );

  const text = formatExportReport(result, { days: intervalDays });
  const { data: sadmins } = await db.from("admins").select("telegram_user_id").eq("is_super_admin", true);
  for (const a of sadmins ?? []) {
    const uid = Number(a.telegram_user_id);
    if (!Number.isFinite(uid)) continue;
    try {
      await sendMessage(uid, text, { disable_web_page_preview: true });
    } catch (e) {
      console.error("db-export notify failed:", e);
    }
  }

  return Response.json({
    ok: true,
    folder: result.folder,
    tables: result.tables.length,
    rows: result.totalRows,
    failed: result.failed,
    pruned: result.pruned,
  });
}
