// Convert Telegram message text + entities into HTML that Telegram's
// `parse_mode: "HTML"` can re-render. Entities use UTF-16 code-unit offsets,
// so we operate on UTF-16 units to match Telegram's semantics exactly.

interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  user?: { id: number };
  custom_emoji_id?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrap(type: string, inner: string, e: TgEntity): string {
  switch (type) {
    case "bold": return `<b>${inner}</b>`;
    case "italic": return `<i>${inner}</i>`;
    case "underline": return `<u>${inner}</u>`;
    case "strikethrough": return `<s>${inner}</s>`;
    case "spoiler": return `<tg-spoiler>${inner}</tg-spoiler>`;
    case "blockquote": return `<blockquote>${inner}</blockquote>`;
    case "expandable_blockquote": return `<blockquote expandable>${inner}</blockquote>`;
    case "code": return `<code>${inner}</code>`;
    case "pre": return e.language ? `<pre><code class="language-${e.language}">${inner}</code></pre>` : `<pre>${inner}</pre>`;
    case "text_link": return `<a href="${(e.url ?? "").replace(/"/g, "&quot;")}">${inner}</a>`;
    case "text_mention": return `<a href="tg://user?id=${e.user?.id ?? 0}">${inner}</a>`;
    case "custom_emoji": return `<tg-emoji emoji-id="${e.custom_emoji_id ?? ""}">${inner}</tg-emoji>`;
    default: return inner;
  }
}

const SUPPORTED = new Set([
  "bold","italic","underline","strikethrough","spoiler","blockquote","expandable_blockquote",
  "code","pre","text_link","text_mention","custom_emoji",
]);

export function messageToHtml(text: string, entities?: TgEntity[]): string {
  const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  // Actually text.length in JS = UTF-16 code units already. Use text directly by index.
  if (!entities?.length) return escapeHtml(text);

  // Sort by offset asc, then length desc (outer first) — enables nesting via recursion.
  const sorted = [...entities].filter(e => SUPPORTED.has(e.type)).sort((a, b) =>
    a.offset - b.offset || b.length - a.length
  );

  function render(start: number, end: number, from: number): string {
    let out = "";
    let cursor = start;
    let i = from;
    while (i < sorted.length) {
      const e = sorted[i];
      if (e.offset >= end) break;
      if (e.offset < cursor) { i++; continue; }
      // Append plain text before this entity
      out += escapeHtml(text.slice(cursor, e.offset));
      const eEnd = e.offset + e.length;
      // Find next index j where children end
      let j = i + 1;
      while (j < sorted.length && sorted[j].offset < eEnd) j++;
      const inner = render(e.offset, Math.min(eEnd, end), i + 1);
      out += wrap(e.type, inner, e);
      cursor = Math.min(eEnd, end);
      i = j;
    }
    out += escapeHtml(text.slice(cursor, end));
    return out;
  }

  // Suppress unused warning for units var (kept for clarity that offsets are UTF-16)
  void units;

  return render(0, text.length, 0);
}
