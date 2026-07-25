// Link-shortener verification gate.
//
// Users must occasionally open a shortener link (earning revenue for the
// bot owner) before continuing to receive files. Config is stored in
// bot_settings.key = 'shortener', per-user state on bot_users.sh_*.
//
// Bypass detection: if the round-trip from issuing the link to /start
// verify_<token> is faster than the configured minimum (default 40s),
// or the user never actually hit the web verify endpoint, admins are
// alerted and the user is asked to solve again. We never ban.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage, getBotUsername } from "./telegram";
import { getSetting } from "./settings";

export interface ShortenerConfig {
  enabled: boolean;
  api: string; // full URL. Use {url} placeholder, else the destination URL is appended.
  limit: number; // files per verification
  hours: number; // lifetime of a verification (hours)
  message: string; // HTML shown above the buttons
  tutorial_url: string;
  button_text: string;
  tutorial_text: string;
  min_solve_seconds: number; // bypass threshold
}

const DEFAULTS: ShortenerConfig = {
  enabled: false,
  api: "",
  limit: 15,
  hours: 24,
  message:
    "🔐 <b>Please verify to continue.</b>\n\nOpen the link below to unlock the next batch of files. It helps keep this bot free for everyone.",
  tutorial_url: "",
  button_text: "🔗 Verify link",
  tutorial_text: "📘 How to solve",
  min_solve_seconds: 40,
};

export async function getShortenerConfig(db: SupabaseClient): Promise<ShortenerConfig> {
  const raw = (await getSetting<Partial<ShortenerConfig>>(db, "shortener")) ?? {};
  return { ...DEFAULTS, ...raw };
}

export async function saveShortenerConfig(
  db: SupabaseClient,
  patch: Partial<ShortenerConfig>,
): Promise<void> {
  const current = await getShortenerConfig(db);
  const next = { ...current, ...patch };
  await db
    .from("bot_settings")
    .upsert({ key: "shortener", value: next, updated_at: new Date().toISOString() });
  // Bust the per-request cache
  const { invalidateSetting } = await import("./settings");
  invalidateSetting("shortener");
}

function makeToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function shortenUrl(apiTemplate: string, target: string): Promise<string> {
  if (!apiTemplate) return target;
  const url = apiTemplate.includes("{url}")
    ? apiTemplate.replace("{url}", encodeURIComponent(target))
    : apiTemplate + encodeURIComponent(target);
  try {
    const res = await fetch(url, { method: "GET" });
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j: any = await res.json();
      // Common shapes: { shortenedUrl }, { short }, { shortened_url }, { data: { url } }
      const short =
        j.shortenedUrl || j.short || j.shortened_url || j.url || j.data?.url || j.result?.url;
      if (typeof short === "string" && short.startsWith("http")) return short;
    } else {
      const txt = (await res.text()).trim();
      if (txt.startsWith("http")) return txt;
    }
  } catch (e) {
    console.error("shortenUrl failed:", e);
  }
  // Fallback: send the raw URL so the user isn't blocked by shortener downtime.
  return target;
}

async function getWebBase(db: SupabaseClient): Promise<string | null> {
  const v = await getSetting<{ url?: string }>(db, "web_app_url");
  return v?.url?.replace(/\/$/, "") ?? null;
}

/**
 * Check whether this user needs to verify before receiving `code`.
 * Returns true and sends the verify message if gated (caller should return "").
 * Returns false if the user can proceed.
 */
export async function requireVerification(
  db: SupabaseClient,
  userChatId: number,
  code: string,
): Promise<boolean> {
  const cfg = await getShortenerConfig(db);
  if (!cfg.enabled) return false;

  const { data: bu } = await db
    .from("bot_users")
    .select("sh_verified_until, sh_files_used")
    .eq("telegram_id", userChatId)
    .maybeSingle();

  const now = Date.now();
  const validUntil = bu?.sh_verified_until ? new Date(bu.sh_verified_until).getTime() : 0;
  const used = bu?.sh_files_used ?? 0;

  const stillValid = validUntil > now && (cfg.limit <= 0 || used < cfg.limit);
  if (stillValid) return false;

  const webBase = await getWebBase(db);
  if (!webBase) {
    try {
      await sendMessage(
        userChatId,
        "⚠️ File delivery is temporarily unavailable (verification not configured). Please contact an admin.",
      );
    } catch { /* ignore */ }
    return true;
  }

  const token = makeToken();
  await db
    .from("bot_users")
    .update({
      sh_pending_token: token,
      sh_pending_issued_at: new Date().toISOString(),
      sh_pending_verified_at: null,
      sh_pending_code: code,
    })
    .eq("telegram_id", userChatId);

  const verifyUrl = `${webBase}/v/${token}`;
  const shortUrl = await shortenUrl(cfg.api, verifyUrl);

  const buttons: any[][] = [[{ text: cfg.button_text || "🔗 Verify link", url: shortUrl }]];
  if (cfg.tutorial_url) {
    buttons.push([{ text: cfg.tutorial_text || "📘 How to solve", url: cfg.tutorial_url }]);
  }

  try {
    await sendMessage(userChatId, cfg.message, {
      reply_markup: { inline_keyboard: buttons },
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error("shortener verify send failed:", e);
  }
  return true;
}

/** Increment the file counter after a successful delivery. */
export async function bumpFilesUsed(db: SupabaseClient, userChatId: number): Promise<void> {
  const cfg = await getShortenerConfig(db);
  if (!cfg.enabled) return;
  const { data } = await db
    .from("bot_users")
    .select("sh_files_used")
    .eq("telegram_id", userChatId)
    .maybeSingle();
  const next = (data?.sh_files_used ?? 0) + 1;
  await db.from("bot_users").update({ sh_files_used: next }).eq("telegram_id", userChatId);
}

async function notifyAdminsOfBypass(
  db: SupabaseClient,
  userChatId: number,
  username: string | null,
  seconds: number,
  reason: string,
): Promise<void> {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const { data: admins } = await db.from("admins").select("telegram_user_id");
  const uHandle = username ? `@${escape(username)}` : `<code>${userChatId}</code>`;
  const text =
    `⚠️ <b>Shortener bypass suspected</b>\n\n` +
    `User: ${uHandle} (<code>${userChatId}</code>)\n` +
    `Solve time: <b>${seconds}s</b>\n` +
    `Reason: ${escape(reason)}`;
  for (const a of admins ?? []) {
    try {
      await sendMessage(a.telegram_user_id, text);
    } catch { /* ignore */ }
  }
}

/**
 * Handle `/start verify_<token>`. Called from the /start command handler.
 * Delivers the pending file on success or asks the user to solve again on bypass.
 */
export async function handleVerifyDeepLink(
  db: SupabaseClient,
  userChatId: number,
  token: string,
): Promise<string> {
  const cfg = await getShortenerConfig(db);
  const { data: bu } = await db
    .from("bot_users")
    .select(
      "telegram_id, username, sh_pending_token, sh_pending_issued_at, sh_pending_verified_at, sh_pending_code, sh_bypass_count",
    )
    .eq("telegram_id", userChatId)
    .maybeSingle();

  if (!bu || bu.sh_pending_token !== token) {
    return "❌ This verification link is no longer valid. Please request the file again.";
  }

  const issued = bu.sh_pending_issued_at ? new Date(bu.sh_pending_issued_at).getTime() : 0;
  const verified = bu.sh_pending_verified_at ? new Date(bu.sh_pending_verified_at).getTime() : 0;
  const nowMs = Date.now();

  // Bypass 1: user came straight to /start verify_ without ever hitting our web endpoint.
  if (!verified) {
    await db
      .from("bot_users")
      .update({
        sh_bypass_count: (bu.sh_bypass_count ?? 0) + 1,
        sh_pending_token: null,
        sh_pending_issued_at: null,
        sh_pending_verified_at: null,
        sh_pending_code: null,
      })
      .eq("telegram_id", userChatId);
    const seconds = Math.round((nowMs - issued) / 1000);
    await notifyAdminsOfBypass(db, userChatId, bu.username ?? null, seconds, "Skipped verify page");
    return "🚫 Verification page was not visited. Please open the shortener link fully and try again.";
  }

  const seconds = Math.max(0, Math.round((verified - issued) / 1000));
  if (seconds < cfg.min_solve_seconds) {
    await db
      .from("bot_users")
      .update({
        sh_bypass_count: (bu.sh_bypass_count ?? 0) + 1,
        sh_pending_token: null,
        sh_pending_issued_at: null,
        sh_pending_verified_at: null,
        sh_pending_code: null,
      })
      .eq("telegram_id", userChatId);
    await notifyAdminsOfBypass(
      db,
      userChatId,
      bu.username ?? null,
      seconds,
      `Solved in ${seconds}s (minimum ${cfg.min_solve_seconds}s)`,
    );
    return `⚠️ You solved the link in only ${seconds}s. That looks like a bypass tool — please solve the shortener normally and request the file again.`;
  }

  // Success — mark verified for the window, reset counter, deliver pending file.
  const validUntil = new Date(nowMs + cfg.hours * 3600 * 1000).toISOString();
  const pendingCode = bu.sh_pending_code;
  await db
    .from("bot_users")
    .update({
      sh_verified_until: validUntil,
      sh_files_used: 0,
      sh_pending_token: null,
      sh_pending_issued_at: null,
      sh_pending_verified_at: null,
      sh_pending_code: null,
    })
    .eq("telegram_id", userChatId);

  if (pendingCode) {
    const { deliverFileByCode } = await import("./posting");
    const err = await deliverFileByCode(db, userChatId, pendingCode);
    if (err) return err;
    return "";
  }
  return `✅ Verified! You can now request files for the next ${cfg.hours}h or ${cfg.limit} files.`;
}

/** Called by the /v/:token web endpoint. Records that the user actually visited. */
export async function markVerifyVisited(
  db: SupabaseClient,
  token: string,
): Promise<{ ok: boolean; botUsername?: string }> {
  const { data: bu } = await db
    .from("bot_users")
    .select("telegram_id, sh_pending_verified_at")
    .eq("sh_pending_token", token)
    .maybeSingle();
  if (!bu) return { ok: false };
  if (!bu.sh_pending_verified_at) {
    await db
      .from("bot_users")
      .update({ sh_pending_verified_at: new Date().toISOString() })
      .eq("telegram_id", bu.telegram_id);
  }
  const botUsername = await getBotUsername();
  return { ok: true, botUsername };
}
