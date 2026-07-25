// Automatic database export: dumps every app table to CSV into a private
// storage bucket, then hands back signed download links + a summary.
import type { SupabaseClient } from "@supabase/supabase-js";

export const EXPORT_BUCKET = "db-backups";

// Every app-owned table. Keep in sync when new tables are added.
export const EXPORT_TABLES = [
  "activity_log",
  "admin_audit",
  "admins",
  "backup_copies",
  "backup_failures",
  "bot_settings",
  "bot_users",
  "broadcast_jobs",
  "channels",
  "deleted_posts",
  "favorites",
  "fsub_satisfied",
  "pending_deletions",
  "post_copies",
  "post_ratings",
  "posts",
  "referral_bonuses",
  "referrals",
  "scheduled_posts",
  "search_sessions",
  "tag_subscriptions",
  "telegram_web_links",
  "user_roles",
  "user_streaks",
  "warnings",
] as const;

const PAGE_SIZE = 1000;
// Hard cap per table so a runaway table can't blow the request budget.
const MAX_ROWS_PER_TABLE = 200_000;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function tableToCsv(db: SupabaseClient, table: string): Promise<{ csv: string; rows: number }> {
  const lines: string[] = [];
  let header: string[] | null = null;
  let offset = 0;
  while (offset < MAX_ROWS_PER_TABLE) {
    const { data, error } = await db.from(table).select("*").range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    if (!header) {
      header = Object.keys(data[0] as Record<string, unknown>);
      lines.push(header.join(","));
    }
    for (const row of data as Record<string, unknown>[]) {
      lines.push(header.map((c) => csvCell(row[c])).join(","));
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  if (!header) lines.push("(empty)");
  return { csv: lines.join("\n"), rows: Math.max(lines.length - 1, 0) };
}

export type ExportedTable = { table: string; rows: number; bytes: number; url?: string; error?: string };

export type ExportResult = {
  folder: string;
  tables: ExportedTable[];
  totalRows: number;
  totalBytes: number;
  failed: number;
  pruned: number;
};

/** Runs a full CSV export into the private backup bucket. */
export async function runDatabaseExport(
  db: SupabaseClient,
  opts: { signedUrlSeconds?: number; keepFolders?: number } = {},
): Promise<ExportResult> {
  const signedFor = opts.signedUrlSeconds ?? 60 * 60 * 24 * 7;
  const keep = opts.keepFolders ?? 10;
  const folder = new Date().toISOString().replace(/[:.]/g, "-");

  const tables: ExportedTable[] = [];
  for (const table of EXPORT_TABLES) {
    try {
      const { csv, rows } = await tableToCsv(db, table);
      const path = `${folder}/${table}.csv`;
      const blob = new Blob([csv], { type: "text/csv" });
      const { error } = await db.storage.from(EXPORT_BUCKET).upload(path, blob, {
        contentType: "text/csv",
        upsert: true,
      });
      if (error) throw new Error(error.message);
      const signed = await db.storage.from(EXPORT_BUCKET).createSignedUrl(path, signedFor);
      tables.push({ table, rows, bytes: blob.size, url: signed.data?.signedUrl });
    } catch (e) {
      tables.push({ table, rows: 0, bytes: 0, error: (e as Error).message.slice(0, 160) });
    }
  }

  // Manifest for the folder.
  try {
    const manifest = JSON.stringify(
      { created_at: new Date().toISOString(), tables: tables.map(({ table, rows, bytes, error }) => ({ table, rows, bytes, error })) },
      null,
      2,
    );
    await db.storage.from(EXPORT_BUCKET).upload(`${folder}/manifest.json`, new Blob([manifest], { type: "application/json" }), {
      contentType: "application/json",
      upsert: true,
    });
  } catch (e) {
    console.error("db-export manifest failed:", e);
  }

  // Prune old export folders, newest `keep` kept.
  let pruned = 0;
  try {
    const { data: entries } = await db.storage.from(EXPORT_BUCKET).list("", { limit: 200 });
    const folders = (entries ?? []).map((e) => e.name).filter((n) => n && n !== folder).sort();
    const stale = folders.slice(0, Math.max(folders.length + 1 - keep, 0));
    for (const f of stale) {
      const { data: files } = await db.storage.from(EXPORT_BUCKET).list(f, { limit: 200 });
      const paths = (files ?? []).map((x) => `${f}/${x.name}`);
      if (paths.length) {
        await db.storage.from(EXPORT_BUCKET).remove(paths);
        pruned += 1;
      }
    }
  } catch (e) {
    console.error("db-export prune failed:", e);
  }

  return {
    folder,
    tables,
    totalRows: tables.reduce((a, t) => a + t.rows, 0),
    totalBytes: tables.reduce((a, t) => a + t.bytes, 0),
    failed: tables.filter((t) => t.error).length,
    pruned,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Compact Telegram summary with each table name linked to its signed CSV. */
export function formatExportReport(r: ExportResult, opts: { days?: number } = {}): string {
  const head = [
    "🗄️ <b>Database export complete</b>",
    `📦 ${r.tables.length - r.failed}/${r.tables.length} tables • ${r.totalRows.toLocaleString()} rows • ${fmtBytes(r.totalBytes)}`,
    `🕒 <code>${r.folder}</code>${opts.days ? ` • every ${opts.days}d` : ""}`,
    r.pruned ? `🧹 Pruned ${r.pruned} old export${r.pruned === 1 ? "" : "s"}` : "",
    "",
    "Tap a table to download its CSV (links valid 7 days):",
  ].filter(Boolean);

  const rows = r.tables.map((t) =>
    t.error
      ? `⚠️ ${t.table} — ${t.error}`
      : `<a href="${t.url}">${t.table}</a> <i>${t.rows.toLocaleString()}</i>`,
  );

  return [...head, rows.join(" • ")].join("\n");
}
