// Command router for the management bot.
// Each command is a small function that receives context and returns a reply string
// (or null to skip). This keeps features modular — add a new file, register it here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { sendMessage } from "./telegram";
import {
  deliverFileByCode,
  deletePostByCode,
  repostByCode,
  getSchedule,
  saveSchedule,
  queueSize,
  dripQueue,
  resetPostedPosts,
  resetAllPostedPosts,
  type Schedule,
} from "./posting";
import { backupAllToChannel, scanDatabaseToBackups } from "./backups";

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
  isAdmin: boolean;
  isSuperAdmin: boolean;
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
    const categories: { title: string; cmds: string[] }[] = [
      { title: "👤 General", cmds: ["start", "help", "whoami"] },
      { title: "🛡️ Admin management", cmds: ["addadmin", "removeadmin", "listadmins", "genimporttoken"] },
      { title: "📡 Channels", cmds: ["addchannel", "removechannel", "listchannels", "setlog"] },
      { title: "📝 Posting", cmds: ["setcaption", "pauseposting", "resumeposting", "repost", "deletepost", "recentposts"] },
      { title: "⏱️ Queue & drip scheduler", cmds: ["queue", "schedulestatus", "scheduleoff", "setschedule", "dripnow", "reset", "resetall"] },
      { title: "💾 Backups", cmds: ["addbackup", "listbackup", "backup", "scandatabase"] },
      { title: "🔒 Content controls", cmds: ["protect", "spoiler"] },
    ];

    const lines: string[] = ["<b>📖 Available commands</b>"];
    const seen = new Set<string>();

    for (const cat of categories) {
      const catLines: string[] = [];
      for (const name of cat.cmds) {
        const def = commands.get(name);
        if (!def) continue;
        if (def.superOnly && !isSuperAdmin) continue;
        if (def.adminOnly && !isAdmin) continue;
        catLines.push("• " + def.help);
        seen.add(name);
      }
      if (catLines.length) {
        lines.push("", `<b>${cat.title}</b>`, ...catLines);
      }
    }

    const extras: string[] = [];
    for (const [name, def] of commands) {
      if (seen.has(name)) continue;
      if (def.superOnly && !isSuperAdmin) continue;
      if (def.adminOnly && !isAdmin) continue;
      extras.push("• " + def.help);
      seen.add(name);
    }
    if (extras.length) lines.push("", "<b>✨ Other</b>", ...extras);

    lines.push("", "<i>Tip: most commands are admin-only. Use /whoami to check your role.</i>");
    return lines.join("\n");
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
    return data
      .map((c) => `• <b>${c.role}</b> — <code>${c.telegram_chat_id}</code> ${c.title ?? ""}`)
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

register("repost", {
  help: "/repost &lt;code&gt; — repost a stored post to all main channels",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const code = args[0];
    if (!code) return "Usage: /repost &lt;code&gt;";
    const result = await repostByCode(db, code);
    await logAction(db, user, "repost", { code });
    return result;
  },
});

register("deletepost", {
  help: "/deletepost &lt;code&gt; — delete a post from all main channels",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const code = args[0];
    if (!code) return "Usage: /deletepost &lt;code&gt;";
    const result = await deletePostByCode(db, code);
    await logAction(db, user, "delete_post", { code });
    return result;
  },
});

register("recentposts", {
  help: "/recentposts — show last 10 posts with their codes",
  adminOnly: true,
  handler: async ({ db }) => {
    const { data } = await db.from("posts").select("code, caption, posted_at, created_at").order("created_at", { ascending: false }).limit(10);
    if (!data?.length) return "No posts yet.";
    return data
      .map((p) => `${p.posted_at ? "✅" : "🕒"} <code>${p.code}</code> — ${(p.caption ?? "").slice(0, 40) || "(no caption)"}`)
      .join("\n");
  },
});

// ---------------- Phase 3: queue + drip scheduler ----------------

register("queue", {
  help: "/queue — how many posts are waiting in the drip queue",
  adminOnly: true,
  handler: async ({ db }) => {
    const size = await queueSize(db);
    const { count: total } = await db.from("posts").select("*", { count: "exact", head: true });
    return `📥 Queue: <b>${size}</b> waiting (of ${total ?? 0} total).`;
  },
});

register("schedulestatus", {
  help: "/schedulestatus — show current drip schedule",
  adminOnly: true,
  handler: async ({ db }) => {
    const s = await getSchedule(db);
    if (!s.enabled) return "⏹️ Schedule is <b>off</b>. Use /setschedule to configure it.";
    if (s.mode === "interval") {
      const last = s.last_drip_at ? new Date(s.last_drip_at).toISOString() : "never";
      return `▶️ Mode: <b>interval</b>\nEvery <b>${s.interval_minutes}</b> minutes, <b>${s.batch_size}</b> post(s) per drip.\nLast drip: ${last}`;
    }
    if (s.mode === "times") {
      const tzHours = (s.tz_offset_minutes ?? 0) / 60;
      return `▶️ Mode: <b>times</b>\nSlots (UTC${tzHours >= 0 ? "+" : ""}${tzHours}): <b>${s.times.join(", ")}</b>\n<b>${s.per_slot}</b> post(s) per slot.`;
    }
    return "Schedule format not recognized.";
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
  help: "/reset [n] — put the last N posted posts back in queue (default 3)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
    const n = Math.max(1, Math.min(500, Number(args[0]) || 3));
    const result = await resetPostedPosts(db, n);
    if (result.error) return `❌ Reset failed: ${result.error}`;
    await logAction(db, user, "reset_posted", { requested: n, reset: result.reset, codes: result.codes });
    if (!result.reset) return "ℹ️ No posted posts found to reset.";
    const codes = result.codes.slice(0, 10).map((code) => `<code>${code}</code>`).join(", ");
    return `✅ Reset <b>${result.reset}</b> post(s) back to queue.${codes ? `\nCodes: ${codes}` : ""}\nNow run /dripnow ${Math.min(n, result.reset)} to test again.`;
  },
});

register("resetall", {
  help: "/resetall — put every posted post back in queue",
  adminOnly: true,
  handler: async ({ db, user }) => {
    const result = await resetAllPostedPosts(db);
    if (result.error) return `❌ Reset all failed: ${result.error}`;
    await logAction(db, user, "reset_all_posted", { reset: result.reset });
    if (!result.reset) return "ℹ️ No posted posts found to reset.";
    return `✅ Reset <b>${result.reset}</b> posted post(s) back to queue.\nNow run /queue or /dripnow 3.`;
  },
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
  help: "/backup &lt;chat_id&gt; — mirror every stored post to that backup channel (skips already-mirrored)",
  adminOnly: true,
  handler: async ({ db, user, args }) => {
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

    const r = await backupAllToChannel(db, cid);
    await logAction(db, user, "backup_channel", { chatId: cid, ...r });
    const err = r.firstError ? `\n\nFirst error: ${r.firstError.slice(0, 200)}` : "";
    return `💾 Backup to <code>${cid}</code> done — mirrored <b>${r.mirrored}</b>, skipped <b>${r.skipped}</b>, failed <b>${r.failed}</b>.${err}`;
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

export async function dispatchCommand(ctx: CmdCtx, commandName: string): Promise<string | null> {
  const def = commands.get(commandName.toLowerCase());
  if (!def) return null;
  if (def.superOnly && !ctx.isSuperAdmin) return "🚫 This command is for the super-admin only.";
  if (def.adminOnly && !ctx.isAdmin) return "🚫 This command is admin-only.";
  return def.handler(ctx);
}
