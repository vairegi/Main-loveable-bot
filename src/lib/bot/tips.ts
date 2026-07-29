// Rotating "did you know" tips shown one at a time after a user fetches a file.
// The tip index is derived from the user's fetch_count so each delivery shows
// the next tip in the list instead of dumping every feature at once.

export const USER_TIPS: string[] = [
  "❤️ Tap the heart under any post to save it. See everything you saved with /favs.",
  "🗑 Remove a saved post with /rfavs &lt;n&gt; — the number shown next to it in /favs (e.g. /rfavs 2 or /rfavs 1-5).",
  "🏆 /leaderboard shows the top 10 savers of the last 30 days — and your own rank below it.",
  "🎲 /random sends you a random post from the whole archive.",
  "🆕 /recent lists the 10 newest posts.",
  "🔥 /trending shows what everyone has been grabbing this week.",
  "🔎 /similar &lt;#tag&gt; finds more posts with the same tag (e.g. /similar #vanilla).",
  "🔔 /notify &lt;#tag&gt; DMs you whenever a new post with that tag drops. Stop with /unnotify &lt;#tag|all&gt;.",
  "📈 /mystats shows your fetches, saves, streak and referral summary.",
  "🔥 /streak tracks your daily-fetch streak — come back each day to keep it alive.",
  "🎁 /referral gives you an invite link; each friend who joins earns you bonus files.",
  "📖 /help lists every command you can use, grouped by category.",
];

/** Pick one tip based on how many files the user has fetched so far. */
export function tipForIndex(index: number): string {
  if (!USER_TIPS.length) return "";
  const i = ((index % USER_TIPS.length) + USER_TIPS.length) % USER_TIPS.length;
  return USER_TIPS[i];
}

/** Formatted tip line ready to append to a Telegram HTML message. */
export function formatTip(index: number): string {
  const tip = tipForIndex(index);
  return tip ? `💡 <b>Tip:</b> ${tip}` : "";
}
