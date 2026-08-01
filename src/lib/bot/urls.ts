// URL template lists.
//
// An admin stores URL "templates" (e.g. a Pinterest pin link). The longest run
// of digits in the URL is treated as the variable slot; /randomurlN swaps that
// slot for a random number inside the list's configured range, leaving the rest
// of the URL untouched.
//
// Stored in bot_settings under the key "url_templates" so no migration is needed.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSetting, invalidateSetting } from "./settings";

const KEY = "url_templates";

export interface UrlTemplate {
  url: string;
  /** index of the digit slot inside `url` */
  slotStart: number;
  slotEnd: number;
  min: number;
  max: number;
  addedBy?: number;
  createdAt?: string;
}

interface UrlStore {
  items: UrlTemplate[];
}

export function findDigitSlot(url: string): { start: number; end: number; digits: string } | null {
  const matches = [...url.matchAll(/\d+/g)];
  if (!matches.length) return null;
  // longest digit run wins; ties → the last one (usually the id at the end)
  let best = matches[0]!;
  for (const m of matches) {
    if (m[0].length >= best[0].length) best = m;
  }
  const start = best.index ?? 0;
  return { start, end: start + best[0].length, digits: best[0] };
}

export async function loadUrls(db: SupabaseClient): Promise<UrlTemplate[]> {
  const v = await getSetting<UrlStore>(db, KEY);
  return Array.isArray(v?.items) ? v!.items : [];
}

async function saveUrls(db: SupabaseClient, items: UrlTemplate[]): Promise<string | null> {
  const { error } = await db.from("bot_settings").upsert({
    key: KEY,
    value: { items },
    updated_at: new Date().toISOString(),
  });
  invalidateSetting(KEY);
  return error?.message ?? null;
}

export async function addUrl(
  db: SupabaseClient,
  url: string,
  addedBy: number,
): Promise<{ ok: false; msg: string } | { ok: true; index: number; item: UrlTemplate }> {
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, msg: "That doesn't look like a http(s) URL." };
  const slot = findDigitSlot(url);
  if (!slot) return { ok: false, msg: "The URL has no digits to randomize. Add a link that contains a numeric id." };

  const items = await loadUrls(db);
  if (items.some((i) => i.url === url)) return { ok: false, msg: "That URL is already in the list." };

  const digitsLen = slot.digits.length;
  const item: UrlTemplate = {
    url,
    slotStart: slot.start,
    slotEnd: slot.end,
    min: Number("1" + "0".repeat(Math.max(digitsLen - 1, 0))),
    max: Number("9".repeat(digitsLen)),
    addedBy,
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  const err = await saveUrls(db, items);
  if (err) return { ok: false, msg: err };
  return { ok: true, index: items.length, item };
}

export async function removeUrl(
  db: SupabaseClient,
  index: number,
): Promise<{ ok: boolean; msg: string }> {
  const items = await loadUrls(db);
  if (index < 1 || index > items.length) return { ok: false, msg: `No URL #${index}. Use /listurl.` };
  const [removed] = items.splice(index - 1, 1);
  const err = await saveUrls(db, items);
  if (err) return { ok: false, msg: err };
  return { ok: true, msg: removed!.url };
}

export async function setUrlRange(
  db: SupabaseClient,
  index: number | "all",
  min: number,
  max: number,
): Promise<{ ok: boolean; msg: string }> {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    return { ok: false, msg: "Range must be <min> - <max> with max ≥ min." };
  }
  const items = await loadUrls(db);
  if (!items.length) return { ok: false, msg: "No URLs stored yet. Add one with /addurl." };
  if (index === "all") {
    for (const i of items) {
      i.min = min;
      i.max = max;
    }
  } else {
    if (index < 1 || index > items.length) return { ok: false, msg: `No URL #${index}. Use /listurl.` };
    items[index - 1]!.min = min;
    items[index - 1]!.max = max;
  }
  const err = await saveUrls(db, items);
  if (err) return { ok: false, msg: err };
  return { ok: true, msg: `${min} – ${max}` };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function renderRandom(item: UrlTemplate): string {
  const n = randInt(item.min, item.max);
  return item.url.slice(0, item.slotStart) + String(n) + item.url.slice(item.slotEnd);
}

export function generateRandom(item: UrlTemplate, count: number): string[] {
  const out = new Set<string>();
  const span = item.max - item.min + 1;
  const target = Math.min(count, span);
  let guard = target * 40 + 50;
  while (out.size < target && guard-- > 0) out.add(renderRandom(item));
  return [...out];
}

export function parseRange(text: string): { min: number; max: number } | null {
  const m = text.match(/(\d[\d,_]*)\s*(?:-|–|to)\s*(\d[\d,_]*)/i);
  if (!m) return null;
  const min = Number(m[1]!.replace(/[,_]/g, ""));
  const max = Number(m[2]!.replace(/[,_]/g, ""));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}
