// Telegram Bot API client via the Lovable connector gateway.
// Server-only: reads LOVABLE_API_KEY and TELEGRAM_API_KEY from process.env.

const GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function creds() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const telegramKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!telegramKey) throw new Error("TELEGRAM_API_KEY is not configured");
  return { lovableKey, telegramKey };
}

export async function tg<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const { lovableKey, telegramKey } = creds();
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${GATEWAY}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": telegramKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw new Error(`Telegram ${method} network error: ${(e as Error).message}`);
    }

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body (e.g. Cloudflare "error code: 502" plain text) — retry on 5xx.
      const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
      lastErr = new Error(`Telegram ${method} gateway ${res.status}: ${snippet || "non-JSON body"}`);
      if (res.status >= 500 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw lastErr;
    }

    if (!res.ok || !data?.ok) {
      const retryAfter = Number(data?.parameters?.retry_after);
      if ((res.status === 429 || data?.error_code === 429) && Number.isFinite(retryAfter) && attempt < maxAttempts) {
        lastErr = new Error(`Telegram ${method} 429 retry_after=${retryAfter}s`);
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000 + 250));
        continue;
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        lastErr = new Error(`Telegram ${method} failed [${res.status}]`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw new Error(`Telegram ${method} failed [${res.status}]: ${JSON.stringify(data)}`);
    }
    return data.result as T;
  }
  throw (lastErr instanceof Error ? lastErr : new Error(`Telegram ${method} failed`));
}

export async function sendMessage(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

export async function sendPhoto(chatId: number | string, photo: string, extra: Record<string, unknown> = {}) {
  return tg("sendPhoto", { chat_id: chatId, photo, parse_mode: "HTML", ...extra });
}

export async function sendVideo(chatId: number | string, video: string, extra: Record<string, unknown> = {}) {
  return tg("sendVideo", { chat_id: chatId, video, parse_mode: "HTML", ...extra });
}

export async function sendDocument(chatId: number | string, document: string, extra: Record<string, unknown> = {}) {
  return tg("sendDocument", { chat_id: chatId, document, parse_mode: "HTML", ...extra });
}

export async function sendAudio(chatId: number | string, audio: string, extra: Record<string, unknown> = {}) {
  return tg("sendAudio", { chat_id: chatId, audio, parse_mode: "HTML", ...extra });
}

export async function copyMessage(
  chatId: number | string,
  fromChatId: number | string,
  messageId: number,
  extra: Record<string, unknown> = {},
) {
  return tg("copyMessage", {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function forwardMessage(
  chatId: number | string,
  fromChatId: number | string,
  messageId: number,
  extra: Record<string, unknown> = {},
) {
  return tg("forwardMessage", {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    disable_notification: true,
    ...extra,
  });
}

export async function editMessageCaption(
  chatId: number | string,
  messageId: number,
  caption: string,
  extra: Record<string, unknown> = {},
) {
  return tg("editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function deleteMessage(chatId: number | string, messageId: number) {
  return tg("deleteMessage", { chat_id: chatId, message_id: messageId });
}

let cachedBotUsername: string | null = null;
export async function getBotUsername(): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await tg<{ username: string }>("getMe");
  cachedBotUsername = me.username;
  return me.username;
}
