// CSV export helpers.
import type { SupabaseClient } from "@supabase/supabase-js";

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function buildUsersCsv(db: SupabaseClient): Promise<string> {
  const columns = ["telegram_user_id", "username", "first_name", "fetch_count", "last_seen", "banned", "banned_reason", "created_at"];
  const rows: string[] = [columns.join(",")];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await db
      .from("bot_users")
      .select(columns.join(","))
      .order("telegram_user_id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const r of data as any[]) {
      rows.push(columns.map((c) => csvEscape(r[c])).join(","));
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows.join("\n");
}

// Send a CSV document via Telegram multipart. Uses the gateway.
export async function sendCsvDocument(chatId: number, filename: string, csv: string, caption?: string): Promise<void> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const telegramKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey || !telegramKey) throw new Error("Telegram credentials not configured");

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([csv], { type: "text/csv" }), filename);

  const res = await fetch("https://connector-gateway.lovable.dev/telegram/sendDocument", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": telegramKey,
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sendDocument failed ${res.status}: ${text.slice(0, 200)}`);
  }
}
