// Single source of truth for command documentation.
// Consumed by:
//   - the bot's /help (compact list grouped by category)
//   - the public /commands web page (full descriptions)
//
// When you add or rename a command in src/lib/bot/commands.ts, update the
// matching entry here so both surfaces stay in sync.

export type CommandRole = "user" | "admin" | "super";

export interface CommandDoc {
  /** command name without the leading slash */
  name: string;
  /** short one-line description */
  description: string;
  /** optional argument syntax, e.g. "<user_id> [reason]" */
  syntax?: string;
  /** longer explanation or examples (plain text, may contain newlines) */
  details?: string;
  /** who can run it */
  role: CommandRole;
}

export interface CommandCategory {
  title: string;
  emoji: string;
  slug: string;
  commands: CommandDoc[];
}

export const COMMAND_CATEGORIES: CommandCategory[] = [
  {
    title: "General",
    emoji: "👤",
    slug: "general",
    commands: [
      { name: "start", role: "user", description: "Bootstrap super-admin (first user) or show welcome." },
      { name: "help", role: "user", description: "Show the command index." },
      { name: "whoami", role: "user", description: "Show your Telegram ID and role." },
      { name: "favs", role: "user", description: "List posts you've saved with ❤️." },
      { name: "rfavs", role: "user", syntax: "<n> [n...]", description: "Remove favorites by number from /favs (e.g. /rfavs 1 or /rfavs 1-5). Also accepts codes or t.me links." },
    ],
  },
  {
    title: "Discovery",
    emoji: "🔎",
    slug: "discovery",
    commands: [
      { name: "random", role: "user", description: "Get a random published post." },
      { name: "recent", role: "user", description: "10 most recently published posts." },
      { name: "trending", role: "user", description: "Most fetched posts in the last 7 days." },
      { name: "similar", role: "user", syntax: "<#tag>", description: "Find posts matching a tag among already-published posts." },
      { name: "leaderboard", role: "user", description: "Top savers by fetches in the last 30 days." },
    ],
  },
  {
    title: "Admin management",
    emoji: "🛡️",
    slug: "admin-management",
    commands: [
      { name: "addadmin", role: "super", syntax: "<user_id>", description: "Grant admin rights to a user." },
      { name: "removeadmin", role: "super", syntax: "<user_id>", description: "Revoke admin rights." },
      { name: "listadmins", role: "admin", description: "Show all admins and super-admins." },
      { name: "genimporttoken", role: "super", description: "Create a token for the MTProto backfill script." },
    ],
  },
  {
    title: "Channels",
    emoji: "📡",
    slug: "channels",
    commands: [
      {
        name: "addchannel",
        role: "admin",
        syntax: "<chat_id> <role>",
        description: "Register a channel.",
        details: "Roles: database | main | log | backup | forcesub.\nTip: forward a channel post to @userinfobot to get its chat_id.",
      },
      { name: "removechannel", role: "admin", syntax: "<chat_id>", description: "Unregister a channel." },
      { name: "listchannels", role: "admin", description: "Show all registered channels with titles." },
      { name: "setlog", role: "admin", syntax: "<chat_id>", description: "Send admin action logs to this channel." },
    ],
  },
  {
    title: "Posting",
    emoji: "📝",
    slug: "posting",
    commands: [
      {
        name: "setcaption",
        role: "admin",
        syntax: "<template>",
        description: "Caption template for main-channel posts.",
        details: "Placeholders: {caption}, {code}.",
      },
      { name: "postcaption", role: "admin", syntax: "<text>", description: "Extra text appended below every main-channel post caption. Send empty to clear." },
      { name: "filecaption", role: "admin", syntax: "<text>", description: "Extra text appended below the caption when files are delivered to users. Send empty to clear." },
      { name: "pauseposting", role: "admin", description: "Pause auto-posting from the database channel." },
      { name: "resumeposting", role: "admin", description: "Resume auto-posting." },
      { name: "repost", role: "admin", syntax: "<code|#N>", description: "Repost a stored post by code or queue position." },
      { name: "dpost", role: "admin", syntax: "<link> [link...]", description: "Manually post one or more database posts to main channels by t.me link." },
      { name: "mpost", role: "admin", syntax: "<link> [link...]", description: "Manually post one or more database posts to the fixed single channel by t.me link." },
      { name: "deletepost", role: "admin", syntax: "<code|#N>", description: "Delete a post (archived, restore with /undelete)." },
      { name: "undelete", role: "admin", syntax: "<code>", description: "Restore a previously deleted post." },
      { name: "deletedposts", role: "admin", description: "List recently deleted posts that can still be restored." },
    ],
  },
  {
    title: "Queue & drip scheduler",
    emoji: "⏱️",
    slug: "queue",
    commands: [
      { name: "queue", role: "admin", description: "Show drip schedule and queue size." },
      { name: "queueinfo", role: "admin", syntax: "[n]", description: "Show upcoming posts about to be posted (default 15, max 50)." },
      { name: "scheduleoff", role: "admin", description: "Pause the drip scheduler." },
      {
        name: "setschedule",
        role: "admin",
        description: "Configure the drip schedule.",
        details:
          "/setschedule interval <minutes> <batch>\n/setschedule times <HH:MM,HH:MM,...> <per_slot> [tz_offset_hours]",
      },
      { name: "dripnow", role: "admin", syntax: "[n]", description: "Publish the next N queued posts immediately (default 1)." },
      { name: "reset", role: "admin", syntax: "[n]", description: "Put the last N posted posts back in queue (default 3, confirms)." },
      { name: "resetall", role: "admin", description: "Put every posted post back in queue (confirms)." },
      { name: "postlater", role: "admin", syntax: "<duration> [code]", description: "Schedule a post. Duration like 5h 2m. With a code publishes that post; reply to media without a code to schedule a one-shot." },
      { name: "postlaterlist", role: "admin", description: "List pending scheduled posts." },
      { name: "postlatercancel", role: "admin", syntax: "<id>", description: "Cancel a scheduled post by id from /postlaterlist." },
    ],
  },
  {
    title: "Backups",
    emoji: "💾",
    slug: "backups",
    commands: [
      { name: "addbackup", role: "admin", syntax: "<chat_id>", description: "Register a backup channel." },
      { name: "removebackup", role: "admin", syntax: "<chat_id>", description: "Unregister a backup channel and clear its mirror log (confirms)." },
      { name: "listbackup", role: "admin", description: "Show all backup channels." },
      { name: "backup", role: "admin", syntax: "<chat_id>", description: "Start/continue mirroring stored posts to a backup channel; remaining posts continue automatically on backup ticks." },
      { name: "backup10", role: "admin", syntax: "<chat_id>", description: "Test: mirror only the next 10 un-mirrored posts." },
      { name: "scandatabase", role: "admin", description: "Forward any new database posts to all backup channels." },
      { name: "resetbackup", role: "admin", syntax: "[chat_id]", description: "Clear mirror log so /backup starts from post 1 (all channels if no id)." },
      { name: "undoresetbackup", role: "admin", syntax: "<chat_id>", description: "Undo an accidental /resetbackup — mark every post as already mirrored so the bot won't re-forward them." },
      { name: "dltbackup", role: "admin", syntax: "<chat_id>", description: "Delete every message the bot mirrored to a backup channel and clear its mirror log (confirms; re-run until remaining = 0)." },
      { name: "pausebackup", role: "admin", description: "Pause auto-backup cron." },
      { name: "resumebackup", role: "admin", description: "Resume auto-backup; posts added while paused mirror on the next cron tick." },
      { name: "backupstatus", role: "admin", description: "Show whether auto-backup is paused or running." },
    ],
  },
  {
    title: "Content controls",
    emoji: "🔒",
    slug: "content-controls",
    commands: [
      { name: "protect", role: "admin", syntax: "1|0", description: "Block forwarding/sharing of posts in main channels." },
      { name: "spoiler", role: "admin", syntax: "1|0", description: "Post photos/videos as spoilers (tap to reveal)." },
      {
        name: "autodelete",
        role: "admin",
        syntax: "<duration>",
        description: "Auto-delete files sent to users after Xh/Xm/Xd.",
        details: "Examples: 12h, 30m, 2d. Use /autodelete off to disable.",
      },
      {
        name: "fsub",
        role: "admin",
        syntax: "<chat_id> <invite_link>",
        description: "Require users to join a channel before Get File works.",
        details: "Use an approval-required invite link so members appear as Join Requests you can approve later.",
      },
      { name: "fsublist", role: "admin", description: "Show forced-subscription channels." },
      { name: "fsubremove", role: "admin", syntax: "<chat_id>", description: "Stop requiring that channel." },
    ],
  },
  {
    title: "Link shortener",
    emoji: "🔗",
    slug: "shortener",
    commands: [
      { name: "shortener", role: "admin", syntax: "on|off|status", description: "Toggle link-shortener verification (default off). Status shows the full config." },
      { name: "shortenerapi", role: "admin", syntax: "<url>", description: "Set the shortener API endpoint. Use {url} placeholder for where the destination URL is substituted." },
      { name: "shortenerlimit", role: "admin", syntax: "<n>", description: "Files a user can fetch before they must solve the shortener again (default 15)." },
      { name: "shortenerhours", role: "admin", syntax: "<n>", description: "Hours a verification stays valid before expiring (default 24)." },
      { name: "shortenermsg", role: "admin", syntax: "<html>", description: "Message shown alongside the verify button when a user hits the limit." },
      { name: "shortenertutorial", role: "admin", syntax: "<url|off>", description: "URL for the tutorial button shown below the verify button. Use 'off' to hide." },
      { name: "shortenerbtn", role: "admin", syntax: "<verify> | <tutorial>", description: "Customize the button labels. Example: /shortenerbtn Verify now | How to open" },
    ],
  },
  {
    title: "Users & moderation",
    emoji: "📊",
    slug: "users-moderation",
    commands: [
      { name: "stats", role: "admin", description: "Bot health: users, posting cadence, top files, backup lag, queue." },
      { name: "duplicates", role: "admin", description: "List posts that share a caption or media file." },
      { name: "doctor", role: "admin", description: "Self-check webhook, DB, channels, drip cron." },
      {
        name: "broadcast",
        role: "admin",
        syntax: "<text>",
        description: "Send text to every user, or reply to a message with /broadcast to forward it.",
        details: "Formatting supported. Replying to a forwarded channel post preserves the original channel tag.",
      },
      { name: "broadcastlater", role: "admin", syntax: "<duration> <text|reply>", description: "Queue a broadcast for later (e.g. 5h). Reply to a message to schedule a forward." },
      { name: "exportusers", role: "admin", description: "Download every bot user as a CSV attachment." },
      { name: "activity", role: "admin", syntax: "[n]", description: "Show latest N activity log entries (default 20, max 100)." },
      { name: "ban", role: "admin", syntax: "<user_id> [reason]", description: "Block a user from fetching files." },
      { name: "unban", role: "admin", syntax: "<user_id>", description: "Remove ban." },
      { name: "banlist", role: "admin", description: "Show banned users." },
      { name: "unbanall", role: "admin", description: "Unban every banned user." },
      
      
      { name: "favsall", role: "admin", description: "Top savers ranked by total saves." },
      { name: "favsrecent", role: "admin", description: "Show recent favorites across all users." },
      { name: "whosaved", role: "admin", syntax: "<code>", description: "List users who saved a specific post." },
      { name: "topfavs", role: "admin", description: "Most-saved posts with saver counts." },
    ],
  },
  {
    title: "Web admin",
    emoji: "🌐",
    slug: "web-admin",
    commands: [
      { name: "linkweb", role: "admin", description: "Get a one-time link to sign into the admin web page." },
      { name: "setweburl", role: "super", syntax: "<url>", description: "Set the base URL used by /linkweb." },
    ],
  },
];

/** Public URL for the docs page. Referenced from /help footer. */
export const COMMANDS_DOCS_URL = "https://grow-our-vision.lovable.app/commands";

export function commandsVisibleTo(role: CommandRole): CommandCategory[] {
  const allow = (c: CommandDoc) => {
    if (c.role === "user") return true;
    if (c.role === "admin") return role === "admin" || role === "super";
    return role === "super";
  };
  return COMMAND_CATEGORIES
    .map((cat) => ({ ...cat, commands: cat.commands.filter(allow) }))
    .filter((cat) => cat.commands.length > 0);
}
