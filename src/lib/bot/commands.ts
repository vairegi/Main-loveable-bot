// Command router for the management bot.
// Each command is a small function that receives context and returns a reply string
// (or null to skip). This keeps features modular — add a new file, register it here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { sendMessage, editMessageText, forwardMessage, tg } from "./telegram";
import {
  deliverFileByCode,
  deletePostByCode,
  undeletePostByCode,
  listDeletedPosts,
  repostByCode,
  postByLink,
  getSchedule,
  saveSchedule,
  queueSize,
  dripQueue,
  resetPostedPosts,
  resetAllPostedPosts,
  type Schedule,
} from "./posting";
import { backupAllToChannel, scanDatabaseToBackups, resetBackupTracking, removeBackupChannel, wipeBackupChannelMessages } from "./backups";
import { getAutodeleteSeconds, setAutodeleteSeconds, parseDuration, formatDuration } from "./autodelete";
import { listForceSubChannels, addForceSubChannel, removeForceSubChannel } from "./fsub";
import { promptConfirm, registerConfirmExecutor } from "./confirm";


export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface CmdCtx {
  db: SupabaseClient;
  chatId: number;
  user: TgUser;
  args: string[];
  rawText: string;
  rawHtml: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  message?: any;
}


type Handler = (ctx: CmdCtx) => Promise<string | null>;

interface CmdDef {
  handler: Handler;
  help: string;
  adminOnly?: boolean;
  superOnly?: boolean;
}

const commands = new Map<string, CmdDef>();

function register(name: string, def: CmdDef) {
  commands.set(name.toLowerCase(), def);
}

// ---------------- Log helper ----------------
async function logAction(db: SupabaseClient, user: TgUser, action: string, details?: unknown) {
  const { error } = await db.from("activity_log").insert({
    actor_id: user.id,
    actor_username: user.username ?? null,
    action,
    details: details ?? null,
  });
  if (error) return { error };

  // Also post to the log channel if configured
  const { data: setting } = await db
    .from("bot_settings")
    .select("value")
    .eq("key", "log_channel_id")
    .maybeSingle();
  const logChannelId = setting?.value?.chat_id;
  if (logChannelId) {
    const who = user.username ? `@${user.username}` : `${user.first_name ?? "user"} (${user.id})`;
    const detailStr = details ? `\n<code>${JSON.stringify(details).slice(0, 500)}</code>` : "";
    try {
      await sendMessage(logChannelId, `📋 <b>${action}</b>\nby ${who}${detailStr}`);
    } catch {
      /* log channel may not be reachable; ignore */
    }
  }

  return { error: null };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type BroadcastUser = { telegram_user_id: number; username: string | null; first_name: string | null };

async function loadBroadcastTargets(db: SupabaseClient): Promise<{ users: BroadcastUser[]; error?: string }> {
  const users: BroadcastUser[] = [];
  const seen = new Set<number>();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("bot_users")
      .select("telegram_user_id, username, first_name")
      .eq("banned", false)
      .order("telegram_user_id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) return { users, error: error.message };

    for (const row of data ?? []) {
      const id = Number(row.telegram_user_id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      users.push({
        telegram_user_id: id,
        username: (row as any).username ?? null,
        first_name: (row as any).first_name ?? null,
      });
    }

    if (!data || data.length < pageSize) break;
  }

  return { users };
}

function formatFailureLine(u: BroadcastUser, reason: string, blocked: boolean): string {
  const name = u.username ? `@${escapeHtml(u.username)}` : (u.first_name ? escapeHtml(u.first_name) : "—");
  const badge = blocked ? "🚫" : "⚠️";
  return `${badge} <code>${u.telegram_user_id}</code> ${name} — ${escapeHtml(reason.slice(0, 200))}`;
}

// ---------------- Commands ----------------

register("start", {
  help: "/start — bootstrap super-admin (first user) or show welcome",
  handler: async ({ db, user, chatId, args }) => {
    // Deep-link: /start get_<code> → deliver file to this user
    const payload = args[0];
    if (payload && payload.startsWith("get_")) {
      const code = payload.slice("get_".length);
      const err = await deliverFileByCode(db, chatId, code);
      return err || null;
    }

    // Bootstrap: if no admins exist, first /start becomes super-admin
    const { count, error: countError } = await db.from("admins").select("*", { count: "exact", head: true });
    if (countError) return `❌ I couldn't check the admin list: ${countError.message}`;

    if ((count ?? 0) === 0) {
      const { error: insertError } = await db.from("admins").upsert({
        telegram_user_id: user.id,
        username: user.username ?? null,
        first_name: user.first_name ?? null,
        is_super_admin: true,
        added_by: user.id,
      });

      if (insertError) return `❌ I couldn't save you as super-admin: ${insertError.message}`;

      const { error: logError } = await logAction(db, user, "bootstrap_super_admin");
      if (logError) return `👑 <b>Welcome, super-admin!</b>\n\nYou are saved as super-admin, but I couldn't write the activity log yet: ${logError.message}`;

      return `👑 <b>Welcome, super-admin!</b>\n\nYou are the first user, so you now control this bot.\n\nSend /help to see admin commands.`;
    }
    return `👋 Hi ${user.first_name ?? ""}!\n\nThis is a private management bot. Send /help if you're an admin.`;
  },
});

register("help", {
  help: "/help — list commands you can use",
  handler: async ({ isAdmin, isSuperAdmin }) => {
    const { commandsVisibleTo, COMMANDS_DOCS_URL } = await import("./command-catalog");
    const role = isSuperAdmin ? "super" : isAdmin ? "admin" : "user";
    const cats = commandsVisibleTo(role);

    const lines: string[] = ["<b>📖 Commands</b>"];
    for (const cat of cats) {
      lines.push("", `<b>${cat.emoji} ${cat.title}</b>`);
      lines.push(cat.commands.map((c) => c.syntax ? `/${c.name} ${escapeHtml(c.syntax)}` : `/${c.name}`).join(" • "));
    }

    return lines.join("\n");
  },
});

register("commands", {
  help: "/commands — admin-only link to the full commands reference",
  handler: async ({ isAdmin }) => {
    if (!isAdmin) return null; // silent for regular users
    const { COMMANDS_DOCS_URL } = await import("./command-catalog");
    return `📖 <b>Full commands reference</b>\n<a href="${COMMANDS_DOCS_URL}">${COMMANDS_DOCS_URL}</a>`;
  },
});

register("whoami", {
  help: "/whoami — show your Telegram id and role",
  handler: async ({ user, isAdmin, isSuperAdmin }) => {
    const role = isSuperAdmin ? "super-admin 👑" : isAdmin ? "admin 🛡️" : "regular user";
    return `👤 <b>You</b>\nID: <code>${user.id}</code>\nUsername: ${user.username ? "@" + user.username : "—"}\nRole: ${role}`;
  },
});

register("addadmin", {
  help: "/addadmin &lt;user_id&gt; — grant admin (super-admin only)",
  superOnly: true,
  handler: async ({ db, user, args }) => {
    const target = Number(args[0]);
    if (!target) return "Usage: /addadmin &lt;telegram_user_id&gt;";
    const { error } = await db.from("admins").upsert({
      telegram_user_id: target,
      added_by: user.id,
      is_super_admin: false,
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "add_admin", { target });
    return `✅ Admin added: <code>${target}</code>`;
  },
});

register("removeadmin", {
  help: "/removeadmin &lt;user_id&gt; — revoke admin (super-admin only)",
  superOnly: true,
  handler: async ({ db, user, args }) => {
    const target = Number(args[0]);
    if (!target) return "Usage: /removeadmin &lt;telegram_user_id&gt;";
    if (target === user.id) return "❌ You can't remove yourself.";
    const { error } = await db
      .from("admins")
      .delete()
      .eq("telegram_user_id", target)
      .eq("is_super_admin", false);
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "remove_admin", { target });
    return `✅ Admin removed: <code>${target}</code>`;
  },
});

register("listadmins", {
  help: "/listadmins — show all admins",
  adminOnly: true,
  handler: async ({ db }) => {
    const { data } = await db.from("admins").select("*").order("created_at");
    if (!data?.length) return "No admins found.";
    return data
      .map(
        (a) =>
          `${a.is_super_admin ? "👑" : "🛡️"} <code>${a.telegram_user_id}</code> ${a.username ? "@" + a.username : ""}`,
      )
      .join("\n");
  },
});

register("addchannel", {
  help: "/addchannel &lt;chat_id&gt; &lt;role&gt; — role: database|main|log|backup|forcesub",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const chatId = Number(args[0]);
    const role = args[1]?.toLowerCase();
    const validRoles = ["database", "main", "log", "backup", "forcesub"];
    if (!chatId || !role || !validRoles.includes(role)) {
      return `Usage: /addchannel &lt;chat_id&gt; &lt;role&gt;\nRoles: ${validRoles.join(", ")}\n\nTip: to get a channel id, forward a message from the channel to @userinfobot, or add this bot as admin and use /listchannels after posting.`;
    }
    const { error } = await db.from("channels").upsert({
      telegram_chat_id: chatId,
      role,
      added_by: user.id,
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "add_channel", { chatId, role });
    return `✅ Channel <code>${chatId}</code> registered as <b>${role}</b>.`;
  },
});

register("removechannel", {
  help: "/removechannel &lt;chat_id&gt; — unregister a channel",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const chatId = Number(args[0]);
    if (!chatId) return "Usage: /removechannel &lt;chat_id&gt;";
    const { error } = await db.from("channels").delete().eq("telegram_chat_id", chatId);
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "remove_channel", { chatId });
    return `✅ Channel removed: <code>${chatId}</code>`;
  },
});

register("listchannels", {
  help: "/listchannels — show all registered channels",
  adminOnly: true,
  handler: async ({ db }) => {
    const { data } = await db.from("channels").select("*").order("role");
    if (!data?.length) return "No channels registered.";

    // Resolve missing titles via Telegram, then persist for next time.
    const resolved = await Promise.all(
      data.map(async (c: any) => {
        let title: string | null = c.title ?? null;
        if (!title || !String(title).trim()) {
          try {
            const chat: any = await tg("getChat", { chat_id: c.telegram_chat_id });
            title = chat?.title ?? chat?.username ?? null;
            if (title) {
              db.from("channels")
                .update({ title })
                .eq("telegram_chat_id", c.telegram_chat_id)
                .then(() => {}, () => {});
            }
          } catch {
            /* bot may not be a member — leave title null */
          }
        }
        return { ...c, title };
      }),
    );

    return resolved
      .map(
        (c: any) =>
          `• <b>${c.role}</b> — ${c.title ? `<b>${c.title}</b> ` : ""}<code>${c.telegram_chat_id}</code>`,
      )
      .join("\n");
  },
});

register("setlog", {
  help: "/setlog &lt;chat_id&gt; — send admin action logs to this channel",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const chatId = Number(args[0]);
    if (!chatId) return "Usage: /setlog &lt;chat_id&gt;";
    const { error } = await db
      .from("bot_settings")
      .upsert({ key: "log_channel_id", value: { chat_id: chatId }, updated_at: new Date().toISOString() });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "set_log_channel", { chatId });
    return `✅ Log channel set to <code>${chatId}</code>. Future actions will be posted there.`;
  },
});

// ---------------- Phase 2: posting engine ----------------

register("setcaption", {
  help: "/setcaption &lt;template&gt; — caption template for main-channel posts. Placeholders: {caption}, {code}",
  adminOnly: true,
  handler: async ({ db, user, rawText }) => {
    const template = rawText.replace(/^\/setcaption(@\S+)?\s*/i, "").trim();
    if (!template) return "Usage: /setcaption &lt;template&gt;\nExample: /setcaption {caption}\n\n🎬 Tap below to get the file.";
    const { error } = await db.from("bot_settings").upsert({
      key: "caption_template",
      value: { text: template },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "set_caption_template", { template });
    return `✅ Caption template updated. Future auto-posts will use it.`;
  },
});

register("postcaption", {
  help: "/postcaption &lt;text&gt; — extra text appended below every main-channel post caption. Supports formatting (bold, quote, spoiler…). Send with no text to clear.",
  adminOnly: true,
  handler: async ({ db, user, rawHtml }) => {
    const text = rawHtml.replace(/^\/postcaption(@\S+)?\s*/i, "");
    const { error } = await db.from("bot_settings").upsert({
      key: "post_caption_extra",
      value: { text },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "set_post_caption_extra", { text });
    if (!text.trim()) return "✅ Post caption extra <b>cleared</b>. Main-channel posts will use only the template.";
    return `✅ Post caption extra saved. Preview:\n\n${text.slice(0, 800)}`;
  },
});

register("filecaption", {
  help: "/filecaption &lt;text&gt; — extra text appended below the caption when files are delivered to users. Supports formatting (bold, quote, spoiler…). Send with no text to clear.",
  adminOnly: true,
  handler: async ({ db, user, rawHtml }) => {
    const text = rawHtml.replace(/^\/filecaption(@\S+)?\s*/i, "");
    const { error } = await db.from("bot_settings").upsert({
      key: "file_caption_extra",
      value: { text },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "set_file_caption_extra", { text });
    if (!text.trim()) return "✅ File caption extra <b>cleared</b>. Delivered files will use only the original caption.";
    return `✅ File caption extra saved. Preview:\n\n${text.slice(0, 800)}`;
  },
});

register("pauseposting", {
  help: "/pauseposting — pause auto-posting from the database channel",
  adminOnly: true,
  handler: async ({ db, user }) => {
    const { error } = await db.from("bot_settings").upsert({
      key: "posting_paused",
      value: { paused: true },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "pause_posting");
    return "⏸️ Auto-posting paused. New database posts will be stored but not forwarded until you /resumeposting.";
  },
});

register("resumeposting", {
  help: "/resumeposting — resume auto-posting",
  adminOnly: true,
  handler: async ({ db, user }) => {
    const { error } = await db.from("bot_settings").upsert({
      key: "posting_paused",
      value: { paused: false },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "resume_posting");
    return "▶️ Auto-posting resumed.";
  },
});

// Resolve a code|#N|N argument to a post code.
// Returns { code } on success, or { error } on failure.
async function resolveCodeOrPosition(
  db: Parameters<typeof deletePostByCode>[0],
  arg: string,
): Promise<{ code?: string; error?: string }> {
  // Position: "#15" or plain "15"
  const stripped = arg.startsWith("#") ? arg.slice(1) : arg;
  const isPosition = /^\d+$/.test(stripped);
  if (!isPosition) return { code: arg };

  const position = parseInt(stripped, 10);
  if (!Number.isFinite(position) || position <= 0) {
    return { error: `❌ Invalid position: ${arg}` };
  }
  const { count: cursor } = await db
    .from("posts")
    .select("id", { count: "exact", head: true })
    .not("posted_at", "is", null);
  const offset = position - (cursor ?? 0) - 1;
  if (offset < 0) return { error: `❌ Position #${position} is already posted (cursor at ${cursor}).` };
  const { data: row } = await db
    .from("posts")
    .select("code")
    .is("posted_at", null)
    .order("id", { ascending: true })
    .range(offset, offset)
    .maybeSingle();
  if (!row) return { error: `❌ No pending post at position #${position}.` };
  return { code: row.code };
}

register("repost", {
  help: "/repost &lt;code|#N&gt; — repost a stored post (by code or queue position, e.g. /repost 15)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const arg = args[0];
    if (!arg) return "Usage: /repost &lt;code&gt; or /repost &lt;queue-position&gt;";
    const { code, error } = await resolveCodeOrPosition(db, arg);
    if (error || !code) return error ?? "❌ Could not resolve post.";
    const result = await repostByCode(db, code);
    await logAction(db, user, "repost", { code, arg });
    return result;
  },
});

register("mpost", {
  help: "/mpost &lt;link&gt; [link...] — manually post one or more database posts to main channels by t.me link",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const links = args.filter((a) => /t\.me\//i.test(a));
    if (!links.length) return "Usage: /mpost &lt;https://t.me/c/&lt;chat&gt;/&lt;msg&gt;&gt; [more links...]";
    const results: string[] = [];
    for (const link of links) {
      results.push(await postByLink(db, link));
    }
    await logAction(db, user, "mpost", { links, count: links.length });
    return results.join("\n");
  },
});


register("deletepost", {
  help: "/deletepost &lt;code|#N&gt; — delete a post by code or queue position (archived, restore with /undelete)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const arg = args[0];
    if (!arg) return "Usage: /deletepost &lt;code&gt; or /deletepost &lt;queue-position&gt;";
    const { code, error } = await resolveCodeOrPosition(db, arg);
    if (error || !code) return error ?? "❌ Could not resolve post.";
    const result = await deletePostByCode(db, code, user.id);
    await logAction(db, user, "delete_post", { code, arg });
    return result;
  },
});

register("undelete", {
  help: "/undelete &lt;code&gt; — restore a previously deleted post (re-enters the queue for reposting)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const arg = args[0];
    if (!arg) return "Usage: /undelete &lt;code&gt;";
    const result = await undeletePostByCode(db, arg);
    await logAction(db, user, "undelete_post", { code: arg });
    return result;
  },
});

register("deletedposts", {
  help: "/deletedposts — list recently deleted posts that can still be restored",
  adminOnly: true,
  handler: async ({ db }) => {
    const rows = await listDeletedPosts(db, 25);
    if (!rows.length) return "🗑️ No archived deleted posts.";
    const lines = rows.map((r) => {
      const when = new Date(r.deleted_at).toISOString().replace("T", " ").slice(0, 16);
      const preview = (r.caption ?? "").replace(/\s+/g, " ").slice(0, 60);
      return `• <code>${r.code}</code> — ${when}${preview ? ` — ${preview}` : ""}`;
    });
    return `🗑️ <b>Recently deleted</b> (restore with /undelete &lt;code&gt;):\n${lines.join("\n")}`;
  },
});



// ---------------- Phase 3: queue + drip scheduler ----------------

register("queue", {
  help: "/queue — show drip schedule and queue size",
  adminOnly: true,
  handler: async ({ db }) => {
    const size = await queueSize(db);
    const { count: total } = await db.from("posts").select("*", { count: "exact", head: true });
    const queueLine = `📥 Queue: <b>${size}</b> waiting (of ${total ?? 0} total).`;

    const s = await getSchedule(db);
    let scheduleBlock: string;
    if (!s.enabled) {
      scheduleBlock = "⏹️ Schedule is <b>off</b>. Use /setschedule to configure it.";
    } else if (s.mode === "interval") {
      const last = s.last_drip_at ? new Date(s.last_drip_at).toISOString() : "never";
      scheduleBlock = `▶️ Mode: <b>interval</b>\nEvery <b>${s.interval_minutes}</b> minutes, <b>${s.batch_size}</b> post(s) per drip.\nLast drip: ${last}`;
    } else if (s.mode === "times") {
      const tzHours = (s.tz_offset_minutes ?? 0) / 60;
      scheduleBlock = `▶️ Mode: <b>times</b>\nSlots (UTC${tzHours >= 0 ? "+" : ""}${tzHours}): <b>${s.times.join(", ")}</b>\n<b>${s.per_slot}</b> post(s) per slot.`;
    } else {
      scheduleBlock = "Schedule format not recognized.";
    }

    return `${scheduleBlock}\n\n${queueLine}`;
  },
});


function formatNextFire(when: Date, tzMin: number): string {
  const sign = tzMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzMin);
  const tzH = Math.floor(abs / 60);
  const tzM = abs % 60;
  const tzLabel = tzM ? `UTC${sign}${tzH}:${String(tzM).padStart(2, "0")}` : `UTC${sign}${tzH}`;

  const local = new Date(when.getTime() + tzMin * 60_000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mi = String(local.getUTCMinutes()).padStart(2, "0");

  const diffMs = when.getTime() - Date.now();
  let rel: string;
  if (diffMs <= 0) {
    rel = "due now";
  } else {
    const totalMin = Math.round(diffMs / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    rel = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  return `⏰ Next fire: <b>${hh}:${mi}</b> (${tzLabel}) on ${yyyy}-${mm}-${dd} — <i>${rel}</i>`;
}

register("queueinfo", {

  help: "/queueinfo [n] — show upcoming posts about to be posted (default 15, max 50)",

  adminOnly: true,
  handler: async ({ db, args }) => {
    const n = Math.max(1, Math.min(50, Number(args[0]) || 15));

    // cursor = number of already-posted posts
    const { count: postedCount } = await db
      .from("posts")
      .select("*", { count: "exact", head: true })
      .not("posted_at", "is", null);
    const cursor = postedCount ?? 0;

    // pending upcoming posts, in the same order dripQueue publishes them
    const { data: upcoming } = await db
      .from("posts")
      .select("code, caption, media")
      .is("posted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(n);

    const { count: pendingCount } = await db
      .from("posts")
      .select("*", { count: "exact", head: true })
      .is("posted_at", null);
    const pending = pendingCount ?? 0;

    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const lines: string[] = [
      "📋 <b>Queue</b>",
      `cursor=<b>${cursor}</b>, pending=<b>${pending}</b> (showing up to ${n})`,
      "",
    ];

    if (!upcoming?.length) {
      lines.push("<i>No posts waiting in queue.</i>");
    } else {
      upcoming.forEach((p, i) => {
        const num = cursor + i + 1;
        const cap = (p.caption ?? "").replace(/\s+/g, " ").trim();
        const title = cap.split("➤")[0].trim();
        const preview = title ? esc(title) : "<i>(no caption)</i>";
        lines.push(` • #${num} — ${preview}`);
      });
    }

    // Schedule slots + next fire
    const s = await getSchedule(db);
    lines.push("");
    if (!s.enabled) {
      lines.push("<b>Slots</b>: <i>schedule off</i>");
    } else if (s.mode === "times") {
      const tzMin = s.tz_offset_minutes ?? 0;
      const now = new Date();
      const local = new Date(now.getTime() + tzMin * 60_000);
      const yyyy = local.getUTCFullYear();
      const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(local.getUTCDate()).padStart(2, "0");
      const dateKey = `${yyyy}-${mm}-${dd}`;
      const doneSlots = s.slots_done_for === dateKey ? (s.done_slots ?? []) : [];

      lines.push("<b>Slots</b>:");
      for (const t of s.times) {
        const done = doneSlots.includes(t);
        lines.push(` • ${t} × ${s.per_slot} ${done ? "✅" : "⏳"}`);
      }

      // Next fire: first slot today not done and >= now; else first slot tomorrow
      const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
      let nextFire: Date | null = null;
      const parsed = s.times
        .map((t) => {
          const [h, m] = t.split(":").map(Number);
          return { t, mins: h * 60 + m };
        })
        .filter((x) => Number.isFinite(x.mins))
        .sort((a, b) => a.mins - b.mins);

      for (const p of parsed) {
        if (!doneSlots.includes(p.t) && p.mins >= nowMinutes) {
          const d = new Date(local);
          d.setUTCHours(Math.floor(p.mins / 60), p.mins % 60, 0, 0);
          nextFire = new Date(d.getTime() - tzMin * 60_000);
          break;
        }
      }
      if (!nextFire && parsed.length) {
        const first = parsed[0];
        const d = new Date(local);
        d.setUTCDate(d.getUTCDate() + 1);
        d.setUTCHours(Math.floor(first.mins / 60), first.mins % 60, 0, 0);
        nextFire = new Date(d.getTime() - tzMin * 60_000);
      }
      if (nextFire) {
        lines.push("");
        lines.push(formatNextFire(nextFire, tzMin));
      }
    } else if (s.mode === "interval") {
      const last = s.last_drip_at ? new Date(s.last_drip_at) : null;
      const next = last ? new Date(last.getTime() + s.interval_minutes * 60_000) : new Date();
      lines.push(`<b>Interval</b>: every ${s.interval_minutes} min × ${s.batch_size}`);
      lines.push(formatNextFire(next, 0));
    }

    return lines.join("\n");
  },
});



register("scheduleoff", {
  help: "/scheduleoff — pause the drip scheduler",
  adminOnly: true,
  handler: async ({ db, user }) => {
    await saveSchedule(db, { enabled: false });
    await logAction(db, user, "schedule_off");
    return "⏹️ Drip scheduler paused. New posts still enter the queue.";
  },
});

register("setschedule", {
  help:
    "/setschedule interval &lt;minutes&gt; &lt;batch&gt;\n" +
    "/setschedule times &lt;HH:MM,HH:MM,...&gt; &lt;per_slot&gt; [tz_offset_hours]\n" +
    "  Examples:\n" +
    "    /setschedule interval 90 1   (1 post every 90 minutes)\n" +
    "    /setschedule times 09:00,21:00 5 5   (5 posts at 09:00 &amp; 21:00, UTC+5)\n" +
    "    /setschedule times 20:00 15 0        (15 posts at 20:00 UTC)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const mode = args[0]?.toLowerCase();
    if (mode === "interval") {
      const mins = Number(args[1]);
      const batch = Number(args[2]);
      if (!Number.isFinite(mins) || mins < 1) return "❌ Invalid interval minutes.";
      if (!Number.isFinite(batch) || batch < 1) return "❌ Invalid batch size.";
      const s: Schedule = { enabled: true, mode: "interval", interval_minutes: mins, batch_size: batch, last_drip_at: null };
      await saveSchedule(db, s);
      await logAction(db, user, "set_schedule", s);
      return `✅ Schedule saved: <b>${batch}</b> post(s) every <b>${mins}</b> minutes.`;
    }
    if (mode === "times") {
      const timesRaw = args[1] ?? "";
      const perSlot = Number(args[2]);
      const tzHours = args[3] !== undefined ? Number(args[3]) : 0;
      const times = timesRaw.split(",").map((t) => t.trim()).filter(Boolean);
      const valid = times.every((t) => /^\d{1,2}:\d{2}$/.test(t));
      if (!times.length || !valid) return "❌ Invalid times. Use HH:MM,HH:MM (24h).";
      if (!Number.isFinite(perSlot) || perSlot < 1) return "❌ Invalid per_slot count.";
      if (!Number.isFinite(tzHours)) return "❌ Invalid tz_offset_hours.";
      const s: Schedule = {
        enabled: true,
        mode: "times",
        times,
        per_slot: perSlot,
        tz_offset_minutes: Math.round(tzHours * 60),
      };
      await saveSchedule(db, s);
      await logAction(db, user, "set_schedule", s);
      return `✅ Schedule saved: <b>${perSlot}</b> post(s) at <b>${times.join(", ")}</b> (UTC${tzHours >= 0 ? "+" : ""}${tzHours}).`;
    }
    return "Usage:\n/setschedule interval &lt;minutes&gt; &lt;batch&gt;\n/setschedule times &lt;HH:MM,HH:MM&gt; &lt;per_slot&gt; [tz_offset_hours]";
  },
});

register("dripnow", {
  help: "/dripnow [n] — publish the next N queued posts immediately (default 1)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const n = Math.max(1, Math.min(50, Number(args[0]) || 1));
    const r = await dripQueue(db, n);
    await logAction(db, user, "drip_now", { requested: n, ...r });
    const failureText = r.failures?.length
      ? `\n\nFirst error: ${r.failures[0].reason}${r.failures[0].code ? `\nCode: <code>${r.failures[0].code}</code>` : ""}`
      : "";
    return `📤 Drip complete — posted ${r.posted}, failed ${r.failed}.${failureText}`;
  },
});

register("reset", {
  help: "/reset [n] — put the last N posted posts back in queue (default 3, asks to confirm)",
  adminOnly: true,
  handler: async ({ chatId, user, args }) => {
    const n = Math.max(1, Math.min(500, Number(args[0]) || 3));
    await promptConfirm(
      chatId,
      user.id,
      "rst",
      String(n),
      `⚠️ <b>Confirm reset</b>\n\nThis will move the last <b>${n}</b> posted post(s) back into the queue.\n\nTap <b>Yes</b> to proceed, or Cancel.`,
    );
    return null;
  },
});

registerConfirmExecutor("rst", async ({ db, userId }, payload) => {
  const n = Math.max(1, Math.min(500, Number(payload) || 3));
  const result = await resetPostedPosts(db, n);
  if (result.error) return `❌ Reset failed: ${result.error}`;
  await logAction(db, { id: userId }, "reset_posted", { requested: n, reset: result.reset, codes: result.codes });
  if (!result.reset) return "ℹ️ No posted posts found to reset.";
  const codes = result.codes.slice(0, 10).map((code) => `<code>${code}</code>`).join(", ");
  return `✅ Reset <b>${result.reset}</b> post(s) back to queue.${codes ? `\nCodes: ${codes}` : ""}\nNow run /dripnow ${Math.min(n, result.reset)} to test again.`;
});

register("resetall", {
  help: "/resetall — put every posted post back in queue (asks to confirm)",
  adminOnly: true,
  handler: async ({ chatId, user }) => {
    await promptConfirm(
      chatId,
      user.id,
      "rsa",
      "",
      "⚠️ <b>Confirm reset ALL</b>\n\nThis will move <b>every posted post</b> back into the queue. This cannot be undone.\n\nTap <b>Yes</b> to proceed, or Cancel.",
    );
    return null;
  },
});

registerConfirmExecutor("rsa", async ({ db, userId }) => {
  const result = await resetAllPostedPosts(db);
  if (result.error) return `❌ Reset all failed: ${result.error}`;
  await logAction(db, { id: userId }, "reset_all_posted", { reset: result.reset });
  if (!result.reset) return "ℹ️ No posted posts found to reset.";
  return `✅ Reset <b>${result.reset}</b> posted post(s) back to queue.\nNow run /queue or /dripnow 3.`;
});


function parseToggle(arg: string | undefined): boolean | null {
  if (arg === undefined) return null;
  const v = arg.toLowerCase();
  if (["1", "on", "true", "yes", "enable"].includes(v)) return true;
  if (["0", "off", "false", "no", "disable"].includes(v)) return false;
  return null;
}

register("protect", {
  help: "/protect 1|0 — block forwarding/sharing of posts in main channels",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const val = parseToggle(args[0]);
    if (val === null) return "Usage: /protect 1 (on) or /protect 0 (off)";
    const { error } = await db.from("bot_settings").upsert({
      key: "protect_content",
      value: { enabled: val },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "set_protect_content", { enabled: val });
    return val
      ? "🔒 Protect content <b>ON</b> — future posts can't be forwarded or saved."
      : "🔓 Protect content <b>OFF</b> — sharing/forwarding allowed.";
  },
});

register("spoiler", {
  help: "/spoiler 1|0 — post photos/videos as spoilers (tap to reveal)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const val = parseToggle(args[0]);
    if (val === null) return "Usage: /spoiler 1 (on) or /spoiler 0 (off)";
    const { error } = await db.from("bot_settings").upsert({
      key: "spoiler_media",
      value: { enabled: val },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "set_spoiler_media", { enabled: val });
    return val
      ? "🫥 Spoiler mode <b>ON</b> — photos/videos will be hidden until tapped."
      : "👁️ Spoiler mode <b>OFF</b> — media posts as normal.";
  },
});

register("genimporttoken", {
  help: "/genimporttoken — create a token for the MTProto backfill script (super-admin)",
  superOnly: true,
  handler: async ({ db, user }) => {
    const token = randomBytes(24).toString("base64url");
    const { error } = await db.from("bot_settings").upsert({
      key: "import_token",
      value: { token, created_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "gen_import_token");
    return `🔑 Import token (keep secret, single use for the backfill script):\n<code>${token}</code>\n\nSet it as BOT_IMPORT_TOKEN in the backfill script.`;
  },
});

// ---------------- Backups ----------------

register("addbackup", {
  help: "/addbackup &lt;chat_id&gt; — register a backup channel",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const cid = Number(args[0]);
    if (!cid) return "Usage: /addbackup &lt;chat_id&gt;\nThe bot must be an admin in that channel.";
    const { error } = await db.from("channels").upsert({
      telegram_chat_id: cid,
      role: "backup",
      added_by: user.id,
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "add_backup_channel", { chatId: cid });
    return `✅ Backup channel registered: <code>${cid}</code>.\nUse /backup ${cid} to mirror the entire database into it.`;
  },
});

register("listbackup", {
  help: "/listbackup — show all backup channels",
  adminOnly: true,
  handler: async ({ db }) => {
    const { data } = await db
      .from("channels")
      .select("telegram_chat_id, title, created_at")
      .eq("role", "backup")
      .order("created_at");
    if (!data?.length) return "No backup channels registered. Use /addbackup &lt;chat_id&gt;.";
    const lines = ["<b>💾 Backup channels</b>"];
    for (const c of data) {
      const { count } = await db
        .from("backup_copies")
        .select("*", { count: "exact", head: true })
        .eq("backup_chat_id", c.telegram_chat_id);
      lines.push(`• <code>${c.telegram_chat_id}</code> ${c.title ?? ""} — ${count ?? 0} mirrored`);
    }
    return lines.join("\n");
  },
});

register("backup", {
  help: "/backup &lt;chat_id&gt; — start/continue mirroring stored posts to that backup channel with a live progress bar",
  adminOnly: true,
  handler: async ({ db, chatId, user, args }) => {
    const cid = Number(args[0]);
    if (!cid) return "Usage: /backup &lt;chat_id&gt;\nRegister it first with /addbackup &lt;chat_id&gt;.";

    // Ensure it's registered as a backup channel
    const { data: ch } = await db
      .from("channels")
      .select("telegram_chat_id, role")
      .eq("telegram_chat_id", cid)
      .maybeSingle();
    if (!ch || ch.role !== "backup") {
      return `❌ <code>${cid}</code> is not registered as a backup channel. Run /addbackup ${cid} first.`;
    }

    // Keep manual command work deliberately small. Many database posts include
    // multiple attached files, so a bigger chunk can hit the request time limit
    // before the command has a chance to edit the final status message.
    const BATCH = 5;

    // Send an initial status message we will edit in place with a progress bar.
    let statusMsgId: number | null = null;
    try {
      const m = await sendMessage(chatId, `💾 Starting backup to <code>${cid}</code>…`);
      statusMsgId = m?.message_id ?? null;
    } catch { /* ignore, we'll just return final summary */ }

    const bar = (pct: number) => {
      const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
      return "▓".repeat(filled) + "░".repeat(10 - filled);
    };

    // Queue a continuation job. The auto-backup worker will keep processing
    // this specific channel on cron ticks even when global auto-backup is paused,
    // so admins do not need to keep sending /backup manually.
    const nowIso = new Date().toISOString();
    const { data: jobsRow } = await db
      .from("bot_settings")
      .select("value")
      .eq("key", "manual_backup_jobs")
      .maybeSingle();
    const jobs = ((jobsRow?.value as any) ?? {}) as Record<string, any>;
    const existingJob = jobs[String(cid)] ?? {};
    jobs[String(cid)] = {
      backupChatId: cid,
      requesterChatId: chatId,
      statusMessageId: statusMsgId,
      createdBy: user.id,
      createdAt: existingJob.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await db.from("bot_settings").upsert(
      { key: "manual_backup_jobs", value: jobs, updated_at: nowIso },
      { onConflict: "key" },
    );

    // A fresh /backup command should retry immediately, not wait for an older
    // stuck/backoff timer from a previous transient Telegram/API failure.
    const { data: stuckRow } = await db
      .from("bot_settings")
      .select("value")
      .eq("key", "auto_backup_stuck_state")
      .maybeSingle();
    const stuck = ((stuckRow?.value as any) ?? {}) as Record<string, any>;
    if (stuck[String(cid)]) {
      delete stuck[String(cid)];
      await db.from("bot_settings").upsert(
        { key: "auto_backup_stuck_state", value: stuck, updated_at: nowIso },
        { onConflict: "key" },
      );
    }

    let totalMirrored = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalAll = 0;
    let doneAll = 0;
    let totalToDoAll = 0;
    let firstError: string | undefined;
    let batches = 0;
    let lastEditAt = 0;

    const r = await backupAllToChannel(db, cid, BATCH, async (p) => {
      if (!statusMsgId) return;
      const now = Date.now();
      if (now - lastEditAt < 4000 && p.processed !== p.totalToDo) return;
      lastEditAt = now;
      const overallDone = p.doneAll;
      const overallAll = p.totalAll;
      const pct = overallAll ? Math.floor((overallDone / overallAll) * 100) : 0;
      const text =
        `💾 Backup to <code>${cid}</code>\n` +
        `${bar(pct)}  <b>${pct}%</b>\n` +
        `Overall: <b>${overallDone}</b> / ${overallAll} mirrored\n` +
        `This run: ${p.mirrored} ok, ${p.failed} failed\n` +
        `🔁 Continuation is queued automatically.`;
      try { await editMessageText(chatId, statusMsgId!, text); } catch { /* ignore */ }
    });
    batches = 1;
    totalMirrored = r.mirrored;
    totalFailed = r.failed;
    totalSkipped = r.skipped;
    totalAll = r.totalAll;
    doneAll = r.doneAll;
    totalToDoAll = r.totalToDo;
    if (r.firstError && !firstError) firstError = r.firstError;

    await logAction(db, user, "backup_channel", { chatId: cid, mirrored: totalMirrored, failed: totalFailed, batches });

    const pct = totalAll ? Math.floor((doneAll / totalAll) * 100) : 100;
    const remaining = Math.max(0, totalAll - doneAll);
    if (remaining === 0) {
      const { data: latestJobsRow } = await db
        .from("bot_settings")
        .select("value")
        .eq("key", "manual_backup_jobs")
        .maybeSingle();
      const latestJobs = ((latestJobsRow?.value as any) ?? {}) as Record<string, any>;
      if (latestJobs[String(cid)]) {
        delete latestJobs[String(cid)];
        await db.from("bot_settings").upsert(
          { key: "manual_backup_jobs", value: latestJobs, updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );
      }
    }
    const err = firstError ? `\n\nFirst error: ${firstError.slice(0, 200)}` : "";
    const more = remaining > 0
      ? `\n\n🔁 <b>${remaining}</b> post(s) still pending. Continuation is queued — the backup worker will keep mirroring this channel automatically on the next ticks, even if auto-backup is paused.`
      : `\n\n✅ All caught up.`;

    const finalText =
      `💾 Backup to <code>${cid}</code>\n` +
      `${bar(pct)}  <b>${pct}%</b>\n` +
      `Overall: <b>${doneAll}</b> / ${totalAll} mirrored\n` +
      `This run: mirrored <b>${totalMirrored}</b>, failed <b>${totalFailed}</b>, already-had <b>${totalSkipped}</b>, batches <b>${batches}</b>.${more}${err}`;

    if (statusMsgId) {
      try { await editMessageText(chatId, statusMsgId, finalText); return null; } catch { /* fallthrough */ }
    }
    return finalText;

  },
});

register("backup10", {
  help: "/backup10 &lt;chat_id&gt; — test: mirror only the next 10 un-mirrored posts to that backup channel",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const cid = Number(args[0]);
    if (!cid) return "Usage: /backup10 &lt;chat_id&gt;\nRegister it first with /addbackup &lt;chat_id&gt;.";

    const { data: ch } = await db
      .from("channels")
      .select("telegram_chat_id, role")
      .eq("telegram_chat_id", cid)
      .maybeSingle();
    if (!ch || ch.role !== "backup") {
      return `❌ <code>${cid}</code> is not registered as a backup channel. Run /addbackup ${cid} first.`;
    }

    const r = await backupAllToChannel(db, cid, 10);
    await logAction(db, user, "backup_channel_test10", { chatId: cid, ...r });
    const err = r.firstError ? `\n\nFirst error: ${r.firstError.slice(0, 200)}` : "";
    return `🧪 Test backup (max 10) to <code>${cid}</code> — mirrored <b>${r.mirrored}</b>, skipped <b>${r.skipped}</b>, failed <b>${r.failed}</b>.\n\nIf this looks good, run /backup ${cid} for the full mirror.${err}`;
  },
});

register("scandatabase", {
  help: "/scandatabase — forward any new database posts to all backup channels",
  adminOnly: true,
  handler: async ({ db, user }) => {
    const { channels, totalChannels } = await scanDatabaseToBackups(db);
    if (!totalChannels) return "ℹ️ No backup channels registered. Use /addbackup &lt;chat_id&gt;.";

    await logAction(db, user, "scan_database", { channels });
    const lines: string[] = [`🔎 Scanned database → ${totalChannels} backup channel(s):`];
    let firstError: string | undefined;
    for (const { chatId: cid, result } of channels) {
      lines.push(
        `• <code>${cid}</code> — mirrored <b>${result.mirrored}</b>, skipped <b>${result.skipped}</b>, failed <b>${result.failed}</b>`,
      );
      if (!firstError && result.firstError) firstError = result.firstError;
    }
    if (firstError) lines.push("", `First error: ${firstError.slice(0, 200)}`);
    return lines.join("\n");
  },
});

register("removebackup", {
  help: "/removebackup &lt;chat_id&gt; — unregister a backup channel and clear its mirror log (asks to confirm)",
  adminOnly: true,
  handler: async ({ chatId, user, args }) => {
    const cid = Number(args[0]);
    if (!cid) return "Usage: /removebackup &lt;chat_id&gt;";
    await promptConfirm(
      chatId,
      user.id,
      "rmb",
      String(cid),
      `⚠️ <b>Confirm remove backup</b>\n\nThis will unregister backup channel <code>${cid}</code> and delete all its mirror-tracking rows.\n\nTap <b>Yes</b> to proceed, or Cancel.`,
    );
    return null;
  },
});

registerConfirmExecutor("rmb", async ({ db, userId }, payload) => {
  const cid = Number(payload);
  if (!cid) return "❌ Invalid channel id.";
  const r = await removeBackupChannel(db, cid);
  if (r.error) return `❌ ${r.error}`;
  if (!r.removed) return `ℹ️ <code>${cid}</code> is not a registered backup channel.`;
  await logAction(db, { id: userId }, "remove_backup_channel", { chatId: cid, clearedCopies: r.clearedCopies });
  return `✅ Backup channel <code>${cid}</code> removed.\nCleared <b>${r.clearedCopies}</b> mirror-tracking row(s).`;
});


register("resetbackup", {
  help: "/resetbackup [chat_id] — clear mirror log so /backup starts from post 1 (all channels if no id)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const cid = args[0] ? Number(args[0]) : undefined;
    if (args[0] && !cid) return "Usage: /resetbackup [chat_id]";
    const r = await resetBackupTracking(db, cid);
    if (r.error) return `❌ ${r.error}`;
    await logAction(db, user, "reset_backup_tracking", { chatId: cid ?? null, cleared: r.cleared });
    const scope = cid ? `<code>${cid}</code>` : "<b>all backup channels</b>";
    return `♻️ Reset mirror log for ${scope} — cleared <b>${r.cleared}</b> row(s).\nRun /backup ${cid ?? "&lt;chat_id&gt;"} to mirror everything again from post 1.`;
  },
});

register("dltbackup", {
  help: "/dltbackup <chat_id> — delete every message the bot mirrored to a backup channel and clear its mirror log (asks to confirm; re-run until remaining = 0)",
  adminOnly: true,
  handler: async ({ chatId, user, args }) => {
    const cid = Number(args[0]);
    if (!cid) return "Usage: /dltbackup &lt;chat_id&gt;";
    await promptConfirm(
      chatId,
      user.id,
      "wpb",
      String(cid),
      `⚠️ <b>Confirm delete backup</b>\n\nThis will delete every message the bot mirrored to <code>${cid}</code> and clear its mirror log.\n\nBot must be an admin with delete rights in that channel. Re-run until <b>remaining = 0</b>.\n\nTap <b>Yes</b> to proceed.`,
    );
    return null;
  },
});

registerConfirmExecutor("wpb", async ({ db, userId }, payload) => {
  const cid = Number(payload);
  if (!cid) return "❌ Invalid channel id.";

  // Auto-rerun: keep wiping in batches until remaining hits 0, we exhaust the
  // time budget for this webhook invocation, or we hit a hard error / too many
  // consecutive failures. Each wipeBackupChannelMessages call handles one
  // batch of ~60 messages with its own inter-message delay.
  const deadline = Date.now() + 50_000; // leave headroom under Worker limit
  let totalDeleted = 0;
  let totalFailed = 0;
  let remaining = 0;
  let firstError: string | undefined;
  let batches = 0;
  const MAX_BATCHES = 40;

  while (batches < MAX_BATCHES) {
    const r = await wipeBackupChannelMessages(db, cid);
    batches++;
    totalDeleted += r.deleted;
    totalFailed += r.failed;
    remaining = r.remaining;
    if (r.firstError && !firstError) firstError = r.firstError;

    if (batches === 1 && r.firstError && r.deleted === 0 && r.failed === 0) {
      return `❌ ${r.firstError}`;
    }
    if (remaining === 0) break;
    if (r.deleted === 0 && r.failed === 0) break;
    if (Date.now() > deadline) break;
  }

  // Once all trackable messages are handled, also clear the mirror log for
  // this channel so the database reflects a full wipe (drops any leftover
  // rows with null backup_message_id from previously-failed mirrors).
  let clearedRows = 0;
  if (remaining === 0) {
    const reset = await resetBackupTracking(db, cid);
    clearedRows = reset.cleared;
    if (reset.error && !firstError) firstError = reset.error;
  }

  await logAction(db, { id: userId }, "wipe_backup_channel", {
    chatId: cid, deleted: totalDeleted, failed: totalFailed, remaining, batches, clearedRows,
  });

  const lines = [
    `🧹 <b>Delete backup</b> <code>${cid}</code>`,
    `Deleted: <b>${totalDeleted}</b>`,
    `Failed: <b>${totalFailed}</b>`,
    `Remaining: <b>${remaining}</b>`,
    `Batches: <b>${batches}</b>`,
  ];
  if (remaining > 0) lines.push("", `Run /dltbackup <code>${cid}</code> again to continue.`);
  else lines.push("", `Mirror log cleared: <b>${clearedRows}</b> row(s).`, `✅ Done. Run /backup <code>${cid}</code> to re-mirror from post 1.`);
  if (firstError) lines.push("", `First error: ${firstError.slice(0, 200)}`);
  return lines.join("\n");
});



register("pausebackup", {
  help: "/pausebackup — pause auto-backup cron (new database posts stop mirroring to backup channels until /resumebackup)",
  adminOnly: true,
  handler: async ({ db, user }) => {
    await db.from("bot_settings").upsert(
      { key: "auto_backup_paused", value: { paused: true, at: new Date().toISOString() } },
      { onConflict: "key" },
    );
    await logAction(db, user, "pause_auto_backup", {});
    return "⏸ <b>Auto-backup paused.</b>\nNew posts will NOT be mirrored to backup channels.\nUse /resumebackup to catch up and resume.";
  },
});

register("resumebackup", {
  help: "/resumebackup — resume auto-backup; all posts added while paused will be forwarded to backup channels on the next cron tick",
  adminOnly: true,
  handler: async ({ db, user }) => {
    await db.from("bot_settings").upsert(
      { key: "auto_backup_paused", value: { paused: false, at: new Date().toISOString() } },
      { onConflict: "key" },
    );
    await logAction(db, user, "resume_auto_backup", {});
    return "▶️ <b>Auto-backup resumed.</b>\nAny posts added while paused will be mirrored to backup channels on the next cron tick (usually within a minute).";
  },
});

register("backupstatus", {
  help: "/backupstatus — show whether auto-backup is paused/running and current backup progress",
  adminOnly: true,
  handler: async ({ db }) => {
    const [{ data: pausedRow }, { data: jobsRow }, { count: totalPosts }, { data: backups }] = await Promise.all([
      db.from("bot_settings").select("value").eq("key", "auto_backup_paused").maybeSingle(),
      db.from("bot_settings").select("value").eq("key", "manual_backup_jobs").maybeSingle(),
      db.from("posts").select("id", { count: "exact", head: true }),
      db.from("channels").select("telegram_chat_id, title").eq("role", "backup").order("created_at"),
    ]);
    const paused = Boolean((pausedRow?.value as { paused?: boolean } | null)?.paused);
    const jobs = ((jobsRow?.value as any) ?? {}) as Record<string, any>;
    const total = Number(totalPosts ?? 0);
    const lines = [
      paused
        ? "⏸ Auto-backup is <b>PAUSED</b>. Manual /backup continuations still run by cron."
        : "▶️ Auto-backup is <b>RUNNING</b>.",
      "",
      "<b>Backup progress</b>",
    ];

    if (!backups?.length) {
      lines.push("No backup channels registered.");
    } else {
      for (const b of backups) {
        const cid = Number(b.telegram_chat_id);
        const { count: done } = await db
          .from("backup_copies")
          .select("post_id", { count: "exact", head: true })
          .eq("backup_chat_id", cid);
        const { count: exhausted } = await db
          .from("backup_failures")
          .select("post_id", { count: "exact", head: true })
          .eq("backup_chat_id", cid)
          .gte("attempts", 3);
        const processed = Math.min(total, Number(done ?? 0) + Number(exhausted ?? 0));
        const pending = Math.max(0, total - processed);
        const pct = total > 0 ? Math.floor((processed / total) * 100) : 100;
        const queued = jobs[String(cid)] ? " 🔁 queued" : "";
        const label = b.title ? `${b.title} (<code>${cid}</code>)` : `<code>${cid}</code>`;
        lines.push(`• ${label}: <b>${processed}</b>/<b>${total}</b> (${pct}%) — ${pending} pending${queued}`);
      }
    }

    lines.push("", "Cron: <b>every minute</b>. Use /backup &lt;chat_id&gt; once to queue continuation, or /resumebackup to fully resume auto-backup.");
    return lines.join("\n");
  },
});

register("autodelete", {
  help: "/autodelete &lt;duration&gt; — auto-delete files sent to users after Xh/Xm/Xd (e.g. 12h, 30m, 2d). Use /autodelete off to disable.",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    if (!args[0]) {
      const cur = await getAutodeleteSeconds(db);
      return cur > 0
        ? `⏳ Auto-delete is <b>${formatDuration(cur)}</b>.\nUse /autodelete off to disable, or /autodelete 12h to change.`
        : "⏹️ Auto-delete is <b>off</b>.\nUse /autodelete 12h (or 30m, 2d) to enable.";
    }
    const secs = parseDuration(args[0]);
    if (secs === null) return "Usage: /autodelete &lt;Xh|Xm|Xd&gt; or /autodelete off";
    await setAutodeleteSeconds(db, secs);
    await logAction(db, user, "set_autodelete", { seconds: secs });
    return secs > 0
      ? `✅ Auto-delete set to <b>${formatDuration(secs)}</b>. Files delivered to users will be removed after that.`
      : "✅ Auto-delete disabled.";
  },
});

register("fsub", {
  help:
    "/fsub &lt;chat_id&gt; &lt;invite_link&gt; — require users to join this channel before Get File works. Use an approval-required invite link so members appear as Join Requests you can approve later.",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const cid = Number(args[0]);
    const link = args[1];
    if (!cid || !link) {
      return "Usage: /fsub &lt;chat_id&gt; &lt;invite_link&gt;\n\nCreate an invite link in the channel with <b>Request Admin Approval</b> turned on, then pass that link here. Users will tap Request to Join; the bot marks them satisfied immediately, and you approve the request in Telegram whenever you like.\n\nSee also: /fsublist, /fsubremove &lt;chat_id&gt;.";
    }
    if (!/^https?:\/\/(t\.me|telegram\.me)\//i.test(link)) {
      return "❌ The invite link must be a full <code>https://t.me/…</code> URL.";
    }
    const { error } = await addForceSubChannel(db, cid, user.id, link);
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "fsub_add", { chatId: cid, link });
    return `✅ Users must now request to join <code>${cid}</code> to receive files.\nInvite link: ${link}`;
  },
});

register("fsublist", {
  help: "/fsublist — show forced-subscription channels",
  adminOnly: true,
  handler: async ({ db }) => {
    const chs = await listForceSubChannels(db);
    if (!chs.length) return "No forced-subscription channels set. Use /fsub &lt;chat_id&gt; &lt;invite_link&gt; to add one.";
    const lines = await Promise.all(chs.map(async (c) => {
      let title = c.title;
      if (!title) {
        try {
          const chat: any = await tg("getChat", { chat_id: c.chat_id });
          title = chat?.title ?? null;
        } catch { /* ignore */ }
      }
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const name = title ? esc(title) : "(unknown)";
      const link = c.invite_link ? esc(c.invite_link) : "(no link)";
      return `• <b>${name}</b>\n   <code>${c.chat_id}</code>\n   ${link}`;
    }));
    return ["<b>🔒 Forced-subscription channels</b>", ...lines].join("\n");
  },
});

register("fsubremove", {
  help: "/fsubremove &lt;chat_id&gt; — stop requiring that channel",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const cid = Number(args[0]);
    if (!cid) return "Usage: /fsubremove &lt;chat_id&gt;";
    const { error } = await removeForceSubChannel(db, cid);
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "fsub_remove", { chatId: cid });
    return `✅ Removed forced channel <code>${cid}</code>.`;
  },
});


// ---------------- Stats / Broadcast / Moderation ----------------

register("stats", {
  help: "/stats — bot health: users, posting cadence, top files, backup lag, queue",
  adminOnly: true,
  handler: async ({ db }) => {
    const now = Date.now();
    const dayAgo = new Date(now - 86_400_000).toISOString();
    const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
    const monthAgo = new Date(now - 30 * 86_400_000).toISOString();
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

    const [
      { count: postCount },
      { count: userCount },
      { count: queueSize },
      { count: bannedCount },
      { count: dau },
      { count: wau },
      { count: mau },
      { count: postedToday },
      { count: posted7d },
      { count: autodeleteQueue },
      { count: failedBackups },
    ] = await Promise.all([
      db.from("posts").select("*", { count: "exact", head: true }),
      db.from("bot_users").select("*", { count: "exact", head: true }),
      db.from("posts").select("*", { count: "exact", head: true }).is("posted_at", null),
      db.from("bot_users").select("*", { count: "exact", head: true }).eq("banned", true),
      db.from("bot_users").select("*", { count: "exact", head: true }).gte("last_seen", dayAgo),
      db.from("bot_users").select("*", { count: "exact", head: true }).gte("last_seen", weekAgo),
      db.from("bot_users").select("*", { count: "exact", head: true }).gte("last_seen", monthAgo),
      db.from("posts").select("*", { count: "exact", head: true }).gte("posted_at", startOfToday),
      db.from("posts").select("*", { count: "exact", head: true }).gte("posted_at", weekAgo),
      db.from("pending_deletions").select("*", { count: "exact", head: true }),
      db.from("backup_failures").select("*", { count: "exact", head: true }),
    ]);

    const { data: topFiles } = await db
      .from("posts")
      .select("code, caption, fetch_count")
      .order("fetch_count", { ascending: false })
      .limit(10);

    const { data: backupChannels } = await db.from("channels").select("telegram_chat_id, title").eq("role", "backup");
    const backupLines: string[] = [];
    if (backupChannels?.length && postCount) {
      for (const ch of backupChannels) {
        const { count: mirrored } = await db
          .from("backup_copies")
          .select("*", { count: "exact", head: true })
          .eq("backup_chat_id", ch.telegram_chat_id);
        const lag = (postCount ?? 0) - (mirrored ?? 0);
        // Age of the oldest un-mirrored post for this channel.
        let ageStr = "";
        if (lag > 0) {
          const { data: mirroredRows } = await db
            .from("backup_copies")
            .select("post_id")
            .eq("backup_chat_id", ch.telegram_chat_id);
          const mirroredIds = new Set((mirroredRows ?? []).map((r) => Number(r.post_id)));
          // Grab the oldest 200 posts and find the first not-yet-mirrored.
          const { data: oldest } = await db
            .from("posts")
            .select("id, created_at")
            .order("id", { ascending: true })
            .limit(500);
          const first = (oldest ?? []).find((p) => !mirroredIds.has(Number(p.id)));
          if (first?.created_at) {
            const ageMs = now - new Date(first.created_at).getTime();
            ageStr = ` · oldest lag ${formatAge(ageMs)}`;
          }
        }
        const label = ch.title ? `<b>${escapeHtml(ch.title)}</b> ` : "";
        backupLines.push(`• ${label}<code>${ch.telegram_chat_id}</code> — ${mirrored ?? 0}/${postCount} (${lag} behind${ageStr})`);
      }
    }

    const topLines = (topFiles ?? [])
      .filter((p) => (p.fetch_count ?? 0) > 0)
      .slice(0, 10)
      .map((p, i) => `${i + 1}. <code>${p.code}</code> — ${p.fetch_count}× — ${escapeHtml((p.caption ?? "").slice(0, 30)) || "(no caption)"}`);

    return [
      "<b>📊 Bot stats</b>",
      "",
      `<b>Posts:</b> ${postCount ?? 0} (queue: ${queueSize ?? 0})`,
      `<b>Published:</b> ${postedToday ?? 0} today · ${posted7d ?? 0} in last 7d`,
      "",
      "<b>👥 Users</b>",
      `Total: <b>${userCount ?? 0}</b> · Banned: ${bannedCount ?? 0}`,
      `Active: <b>${dau ?? 0}</b> DAU · ${wau ?? 0} WAU · ${mau ?? 0} MAU`,
      "",
      `<b>⏱️ Queues</b>`,
      `Autodelete pending: ${autodeleteQueue ?? 0}`,
      `Backup failures logged: ${failedBackups ?? 0}`,
      "",
      "<b>💾 Backup lag</b>",
      backupLines.length ? backupLines.join("\n") : "(no backup channels)",
      "",
      "<b>🔥 Top files</b>",
      topLines.length ? topLines.join("\n") : "(no fetches yet)",
    ].join("\n");
  },
});

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ---------------- /duplicates ----------------
register("duplicates", {
  help: "/duplicates — list posts that share a caption or media file (admins)",
  adminOnly: true,
  handler: async ({ db }) => {
    // Load all posts in chunks (id keyset). Keep memory-only fields.
    const byCaption = new Map<string, { code: string; id: number }[]>();
    const byFileId = new Map<string, { code: string; id: number }[]>();

    let lastId = 0;
    const CHUNK = 1000;
    let scanned = 0;
    while (true) {
      const { data, error } = await db
        .from("posts")
        .select("id, code, caption, media")
        .gt("id", lastId)
        .order("id", { ascending: true })
        .limit(CHUNK);
      if (error) return `❌ ${error.message}`;
      if (!data?.length) break;
      for (const p of data) {
        scanned++;
        const capKey = (p.caption ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        if (capKey.length >= 8) {
          if (!byCaption.has(capKey)) byCaption.set(capKey, []);
          byCaption.get(capKey)!.push({ code: p.code, id: Number(p.id) });
        }
        const media = (p.media ?? {}) as { file_unique_id?: string };
        const fuid = media?.file_unique_id;
        if (fuid) {
          if (!byFileId.has(fuid)) byFileId.set(fuid, []);
          byFileId.get(fuid)!.push({ code: p.code, id: Number(p.id) });
        }
      }
      lastId = Number(data[data.length - 1].id);
      if (data.length < CHUNK) break;
    }

    const capDupes = [...byCaption.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    const fidDupes = [...byFileId.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length).slice(0, 10);

    const { getBotUsername } = await import("./telegram");
    const botUsername = await getBotUsername();
    const linkCode = (c: string) => `<a href="https://t.me/${botUsername}?start=get_${c}"><code>${c}</code></a>`;

    const lines: string[] = [`<b>🔁 Duplicates</b> (scanned ${scanned} posts)`];

    if (capDupes.length) {
      lines.push("", "<b>By caption</b>");
      for (const [key, items] of capDupes) {
        const preview = key.slice(0, 40);
        const codes = items.slice(0, 8).map((it) => linkCode(it.code)).join(" ");
        lines.push(`• ${items.length}× "${escapeHtml(preview)}" — ${codes}`);
      }
    }
    if (fidDupes.length) {
      lines.push("", "<b>By media file</b>");
      for (const [fuid, items] of fidDupes) {
        const codes = items.slice(0, 8).map((it) => linkCode(it.code)).join(" ");
        lines.push(`• ${items.length}× <code>${escapeHtml(fuid.slice(0, 20))}…</code> — ${codes}`);
      }
    }
    if (capDupes.length === 0 && fidDupes.length === 0) {
      lines.push("", "✅ No duplicates found.");
    } else {
      lines.push("", "<i>Tap a code to preview it, or use /deletepost &lt;code&gt; to remove a duplicate.</i>");
    }
    return lines.join("\n");
  },
});

// ---------------- /doctor ----------------
register("doctor", {
  help: "/doctor — self-check webhook, DB, channels, drip cron",
  adminOnly: true,
  handler: async ({ db }) => {
    const check = async <T,>(fn: () => Promise<T>): Promise<{ ok: boolean; detail: string }> => {
      try {
        const r = await fn();
        return { ok: true, detail: typeof r === "string" ? r : "ok" };
      } catch (e: any) {
        return { ok: false, detail: e?.message ?? "error" };
      }
    };

    const results: { name: string; ok: boolean; detail: string }[] = [];

    // 1. Webhook info
    results.push({
      name: "Telegram webhook",
      ...(await check(async () => {
        const info: any = await tg("getWebhookInfo");
        const url = info?.url ?? "(unset)";
        const pending = info?.pending_update_count ?? 0;
        const lastErr = info?.last_error_message ? ` · last error: ${info.last_error_message}` : "";
        return `pending ${pending} · ${url}${lastErr}`;
      })),
    });

    // 2. DB roundtrip
    results.push({
      name: "Database",
      ...(await check(async () => {
        const { error } = await db.from("bot_settings").select("key", { head: true, count: "exact" }).limit(1);
        if (error) throw new Error(error.message);
        return "reachable";
      })),
    });

    // 3. Channels — getChat on main + backup
    const { data: chans } = await db.from("channels").select("telegram_chat_id, title, role").in("role", ["main", "backup", "database", "log"]);
    for (const c of chans ?? []) {
      results.push({
        name: `${c.role} · ${c.title ?? c.telegram_chat_id}`,
        ...(await check(async () => {
          const chat: any = await tg("getChat", { chat_id: c.telegram_chat_id });
          return chat?.title ?? chat?.username ?? "reachable";
        })),
      });
    }

    // 4. Drip cron last run age
    results.push({
      name: "Drip cron",
      ...(await check(async () => {
        const { data } = await db.from("bot_settings").select("value, updated_at").eq("key", "drip_last_run").maybeSingle();
        const ts = (data?.value as any)?.at ?? data?.updated_at;
        if (!ts) return "never run";
        const age = Date.now() - new Date(ts).getTime();
        const marker = age > 6 * 3600_000 ? "⚠️ " : "";
        return `${marker}last ran ${formatAge(age)} ago`;
      })),
    });

    // 5. Autodelete queue
    results.push({
      name: "Autodelete queue",
      ...(await check(async () => {
        const { count } = await db.from("pending_deletions").select("*", { count: "exact", head: true });
        return `${count ?? 0} pending`;
      })),
    });

    // 6. Backup failures
    results.push({
      name: "Backup failures",
      ...(await check(async () => {
        const { count } = await db.from("backup_failures").select("*", { count: "exact", head: true });
        return `${count ?? 0} rows`;
      })),
    });

    const lines = ["<b>🩺 Doctor report</b>", ""];
    for (const r of results) {
      lines.push(`${r.ok ? "✅" : "❌"} <b>${escapeHtml(r.name)}</b> — ${escapeHtml(r.detail).slice(0, 200)}`);
    }
    const failing = results.filter((r) => !r.ok).length;
    lines.push("", failing === 0 ? "<i>All checks passed.</i>" : `<i>${failing} check(s) failing.</i>`);
    return lines.join("\n");
  },
});


register("broadcast", {
  help: "/broadcast &lt;text&gt; — send text to every user (formatting supported). Or reply to any message (including a forwarded channel post) with /broadcast to forward it to everyone, preserving the original channel tag.",
  adminOnly: true,
  handler: async ({ db, user, chatId, rawHtml, message }) => {
    const text = rawHtml.replace(/^\/broadcast(@\S+)?\s*/i, "").trim();
    const reply = message?.reply_to_message;

    if (!text && !reply) {
      return [
        "Usage:",
        "• <code>/broadcast &lt;message&gt;</code> — send text (bold, italic, quote, spoiler…)",
        "• Reply to any message with <code>/broadcast</code> — re-broadcasts it. If it's a forwarded channel post, the <b>Forwarded from</b> tag is preserved.",
      ].join("\n");
    }

    const { users, error: targetError } = await loadBroadcastTargets(db);
    if (targetError) return `❌ I couldn't load broadcast users: ${targetError}`;
    if (!users.length) return "ℹ️ No users to broadcast to yet.";

    const startedAt = Date.now();
    let ok = 0;
    let failed = 0;
    const failures: { user: BroadcastUser; reason: string; blocked: boolean }[] = [];
    const blockedUsers: number[] = [];

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      try {
        if (reply) {
          // forwardMessage keeps the original "Forwarded from <channel>" header
          // when the replied message was itself forwarded from a channel.
          await forwardMessage(u.telegram_user_id, chatId, reply.message_id, { disable_notification: false });
        } else {
          await sendMessage(u.telegram_user_id, text);
        }
        ok++;
      } catch (e: any) {
        failed++;
        const err = String(e?.message ?? e ?? "unknown");
        const isBlocked = /\b403\b|bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(err);
        failures.push({ user: u, reason: err, blocked: isBlocked });
        if (isBlocked) blockedUsers.push(u.telegram_user_id);
      }

      // Telegram allows roughly 30 messages/sec globally. Keep a safe pace and
      // avoid a long pause after the final send.
      if (i < users.length - 1) await wait(40);
    }

    if (blockedUsers.length) {
      await db
        .from("bot_users")
        .update({
          banned: true,
          banned_reason: "Telegram delivery failed: blocked bot or chat unavailable",
          banned_at: new Date().toISOString(),
        })
        .in("telegram_user_id", blockedUsers);
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const successRate = users.length ? ((ok / users.length) * 100).toFixed(1) : "0.0";
    const otherFailed = failures.length - blockedUsers.length;

    await logAction(db, user, "broadcast", {
      total: users.length,
      ok,
      failed,
      blocked: blockedUsers.length,
      mode: reply ? "forward" : "text",
      elapsedSec,
      failedSamples: failures.slice(0, 5).map(f => `${f.user.telegram_user_id}: ${f.reason.slice(0, 160)}`),
    });

    // ---- Summary card ----
    const summary = [
      `📢 <b>Broadcast delivery report</b>`,
      ``,
      `📨 Mode: <b>${reply ? "Forward" : "Text"}</b>`,
      `👥 Targeted: <b>${users.length}</b>`,
      `✅ Delivered: <b>${ok}</b> (${successRate}%)`,
      `❌ Failed: <b>${failed}</b>`,
      `  • 🚫 Blocked / unreachable: <b>${blockedUsers.length}</b>`,
      `  • ⚠️ Other errors: <b>${otherFailed}</b>`,
      `⏱ Duration: <b>${elapsedSec}s</b>`,
    ].join("\n");
    await sendMessage(chatId, summary);

    // ---- Detailed failure list (paginated) ----
    if (failures.length) {
      // Blocked first, then other errors — most useful ordering for admin.
      const sorted = [...failures].sort((a, b) => Number(b.blocked) - Number(a.blocked));
      const header = `📋 <b>Failed deliveries (${failures.length})</b>\n<i>🚫 = blocked / auto-removed · ⚠️ = other error</i>\n\n`;
      const lines = sorted.map(f => formatFailureLine(f.user, f.reason, f.blocked));

      const MAX = 3800; // stay well under Telegram's 4096 limit
      let chunk = header;
      let part = 1;
      const totalParts = (() => {
        let count = 1;
        let size = header.length;
        for (const line of lines) {
          if (size + line.length + 1 > MAX) { count++; size = 0; }
          size += line.length + 1;
        }
        return count;
      })();

      for (const line of lines) {
        if (chunk.length + line.length + 1 > MAX) {
          await sendMessage(chatId, `${chunk}\n\n<i>Part ${part}/${totalParts}</i>`);
          await wait(50);
          part++;
          chunk = "";
        }
        chunk += (chunk ? "\n" : "") + line;
      }
      if (chunk) {
        await sendMessage(chatId, totalParts > 1 ? `${chunk}\n\n<i>Part ${part}/${totalParts}</i>` : chunk);
      }
    }

    // Suppress the automatic reply — we already sent the detailed report.
    return null;
  },
});




register("ban", {
  help: "/ban &lt;user_id&gt; [reason] — block a user from fetching files",
  adminOnly: true,
  handler: async ({ db, user, args, rawText }) => {
    const target = Number(args[0]);
    if (!target) return "Usage: /ban &lt;telegram_user_id&gt; [reason]";
    const reason = rawText.replace(/^\/ban(@\S+)?\s+\S+\s*/i, "").trim() || null;
    const { banUser } = await import("./users");
    const r = await banUser(db, target, reason);
    if (r.error) return `❌ ${r.error}`;
    await logAction(db, user, "ban_user", { target, reason });
    return `🚫 Banned <code>${target}</code>${reason ? ` — ${reason}` : ""}.`;
  },
});

register("unban", {
  help: "/unban &lt;user_id&gt; — remove ban",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const target = Number(args[0]);
    if (!target) return "Usage: /unban &lt;telegram_user_id&gt;";
    const { unbanUser } = await import("./users");
    const r = await unbanUser(db, target);
    if (r.error) return `❌ ${r.error}`;
    await logAction(db, user, "unban_user", { target });
    return `✅ Unbanned <code>${target}</code>.`;
  },
});

register("banlist", {
  help: "/banlist — show banned users",
  adminOnly: true,
  handler: async ({ db }) => {
    const { data } = await db
      .from("bot_users")
      .select("telegram_user_id, username, first_name, banned_reason, banned_at")
      .eq("banned", true)
      .order("banned_at", { ascending: false })
      .limit(100);
    if (!data?.length) return "No banned users.";
    return [
      "<b>🚫 Banned users</b>",
      ...data.map(
        (u) =>
          `• <code>${u.telegram_user_id}</code> ${u.username ? "@" + u.username : (u.first_name ?? "")}${u.banned_reason ? ` — ${u.banned_reason}` : ""}`,
      ),
    ].join("\n");
  },
});

register("search", {
  help: "/search &lt;query&gt; — search hentaifox, tick multiple, then send links (admins)",
  adminOnly: true,
  handler: async ({ db, chatId, user, rawText }) => {
    const query = rawText.replace(/^\/search(@\S+)?\s*/i, "").trim();
    const { handleSearchCommand } = await import("./search");
    return handleSearchCommand(db, chatId, user.id, query);
  },
});





// ---------------- Phase 3: favorites & web admin linking ----------------

register("favs", {
  help: "/favs — list posts you've saved with ❤️",
  handler: async ({ db, user }) => {
    const { data: favs } = await db
      .from("favorites")
      .select("post_id, created_at, posts(id, code, caption)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!favs?.length) return "🤍 You have no favorites yet. Tap the <b>Save</b> button on a delivered file to add one.";

    const { getBotUsername } = await import("./telegram");
    const botUsername = await getBotUsername();
    const lines = ["<b>❤️ Your favorites</b>", ""];
    for (const f of favs as any[]) {
      const p = f.posts;
      if (!p) continue;
      const title = (p.caption ?? "").split("\n")[0].slice(0, 60) || `Post #${p.id}`;
      lines.push(`• <a href="https://t.me/${botUsername}?start=get_${p.code}">${escapeHtml(title)}</a>`);
    }
    return lines.join("\n");
  },
});

register("linkweb", {
  help: "/linkweb — get a one-time link to sign into the admin web page",
  adminOnly: true,
  handler: async ({ db, user }) => {
    const token = randomBytes(16).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const { error } = await db.from("telegram_link_tokens").insert({
      token,
      telegram_user_id: user.id,
      telegram_username: user.username ?? null,
      expires_at: expiresAt,
    });
    if (error) return `❌ ${error.message}`;

    const { data: setting } = await db
      .from("bot_settings")
      .select("value")
      .eq("key", "web_app_url")
      .maybeSingle();
    const baseUrl = (setting?.value as any)?.url
      ?? "https://project--63054181-241c-4222-a8c4-6a324a5c7656.lovable.app";
    const link = `${baseUrl}/link/${token}`;

    await logAction(db, user, "linkweb_token_issued");
    return [
      "🔗 <b>Web admin sign-in link</b>",
      "",
      `<a href="${link}">${link}</a>`,
      "",
      "1. Open the link above",
      "2. Sign up or sign in with your email + password",
      "3. Your Telegram account is linked automatically",
      "",
      "<i>Link expires in 30 minutes and can only be used once.</i>",
    ].join("\n");
  },
});

register("setweburl", {
  help: "/setweburl &lt;url&gt; — set the base URL used by /linkweb (super-admin)",
  superOnly: true,
  handler: async ({ db, user, args }) => {
    const url = args[0];
    if (!url || !/^https?:\/\//i.test(url)) return "Usage: /setweburl https://your.app";
    const clean = url.replace(/\/$/, "");
    const { error } = await db.from("bot_settings").upsert({
      key: "web_app_url",
      value: { url: clean },
      updated_at: new Date().toISOString(),
    });
    if (error) return `❌ ${error.message}`;
    await logAction(db, user, "set_web_app_url", { url: clean });
    return `✅ Web app URL set to <code>${clean}</code>`;
  },
});


export async function dispatchCommand(ctx: CmdCtx, commandName: string): Promise<string | null> {
  const def = commands.get(commandName.toLowerCase());
  if (!def) return null;
  if (def.superOnly && !ctx.isSuperAdmin) return "🚫 This command is for the super-admin only.";
  if (def.adminOnly && !ctx.isAdmin) return "🚫 This command is admin-only.";
  return def.handler(ctx);
}
