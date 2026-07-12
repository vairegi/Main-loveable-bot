// Inline-keyboard confirmation for destructive commands.
//
// Flow:
//   1. User runs a destructive command (e.g. /reset 5). The command handler
//      calls `promptConfirm(...)` and returns null — no immediate action.
//   2. The bot sends a message with Yes / Cancel inline buttons whose
//      callback_data encodes the action + payload + requester userId
//      (so nobody else can hijack the button).
//   3. On tap, `handleConfirmCallback` verifies the caller, looks up the
//      executor, runs it, and edits the message with the result.
//
// Callback data format:  cnf:<action>:<userId>:<payload>
//   - action: short key registered below
//   - userId: original requester's telegram id
//   - payload: action-specific string (may contain colons — we split with 4)
//
// Telegram limits callback_data to 64 bytes, so keep action keys short (3-4
// chars) and payloads compact.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tg, sendMessage, editMessageText } from "./telegram";

export interface ConfirmCtx {
  db: SupabaseClient;
  userId: number;
  chatId: number;
}

type Executor = (ctx: ConfirmCtx, payload: string) => Promise<string>;

const executors = new Map<string, Executor>();

export function registerConfirmExecutor(action: string, exec: Executor): void {
  executors.set(action, exec);
}

/**
 * Send a Yes/Cancel prompt. Returns the sent message id.
 */
export async function promptConfirm(
  chatId: number,
  userId: number,
  action: string,
  payload: string,
  prompt: string,
): Promise<void> {
  const data = `cnf:${action}:${userId}:${payload}`;
  if (data.length > 64) {
    throw new Error(`confirm callback_data too long (${data.length} > 64): ${data}`);
  }
  await sendMessage(chatId, prompt, {
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Yes, do it", callback_data: data },
        { text: "❌ Cancel", callback_data: `cnf:_x:${userId}:` },
      ]],
    },
  });
}

export async function handleConfirmCallback(db: SupabaseClient, cb: any): Promise<void> {
  const cbId: string = cb.id;
  const data: string = cb.data ?? "";
  const msg = cb.message;
  const fromId = Number(cb.from?.id ?? 0);
  if (!msg || !data.startsWith("cnf:")) {
    await tg("answerCallbackQuery", { callback_query_id: cbId });
    return;
  }

  const parts = data.split(":");
  // ["cnf", action, userId, ...payload]
  const action = parts[1] ?? "";
  const requesterId = Number(parts[2] ?? 0);
  const payload = parts.slice(3).join(":");

  if (requesterId && requesterId !== fromId) {
    await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text: "This confirmation belongs to someone else.",
      show_alert: false,
    });
    return;
  }

  const chatId = msg.chat.id as number;
  const messageId = msg.message_id as number;

  if (action === "_x") {
    try { await editMessageText(chatId, messageId, "❌ <i>Cancelled.</i>"); } catch { /* ignore */ }
    await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Cancelled" });
    return;
  }

  const exec = executors.get(action);
  if (!exec) {
    await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text: "This confirmation is no longer valid.",
      show_alert: false,
    });
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Working…" });
  let result: string;
  try {
    result = await exec({ db, userId: fromId, chatId }, payload);
  } catch (e: any) {
    result = `❌ Error: ${e?.message ?? "unknown"}`;
  }
  try {
    await editMessageText(chatId, messageId, result);
  } catch {
    await sendMessage(chatId, result);
  }
}
