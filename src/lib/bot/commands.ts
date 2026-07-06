// Command router for the management bot.
// Each command is a small function that receives context and returns a reply string
// (or null to skip). This keeps features modular — add a new file, register it here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage } from "./telegram";
import { deliverFileByCode, deletePostByCode, repostByCode } from "./posting";

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
  handler: async ({ db, user }) => {
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
    const lines = ["<b>Available commands:</b>", ""];
    for (const [name, def] of commands) {
      if (def.superOnly && !isSuperAdmin) continue;
      if (def.adminOnly && !isAdmin) continue;
      lines.push(def.help);
    }
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

// ---------------- Dispatch ----------------

export async function dispatchCommand(ctx: CmdCtx, commandName: string): Promise<string | null> {
  const def = commands.get(commandName.toLowerCase());
  if (!def) return null;
  if (def.superOnly && !ctx.isSuperAdmin) return "🚫 This command is for the super-admin only.";
  if (def.adminOnly && !ctx.isAdmin) return "🚫 This command is admin-only.";
  return def.handler(ctx);
}
