// Shared helpers for the optional clone-video module. Pure functions only.
import { z } from "zod";

/** Ignored folder for consent records, private provider ids and look state. */
export const PRIVATE_DIR = "clone-private";

function isRealDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const isoDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.")
  .refine(isRealDate, "Not a real calendar date.");

export const nonEmptyText = z.string().trim().min(1);

/** Provider ids are passed through URL paths and request bodies, so keep them to safe characters. */
export const providerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Ids contain 1-128 letters, digits, hyphens or underscores.");

/** Local names for looks (for example "desk-a"); the real look ids stay in the private config. */
export const aliasSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "Look names use 1-32 lowercase letters, digits, hyphens or underscores.");

/** Today's date in local time as YYYY-MM-DD, independent of the machine's locale settings. */
export function localToday(now = new Date()) {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("-");
}

/** Shows enough of an id to recognize it in a terminal without printing the whole value. */
export function mask(id) {
  if (typeof id !== "string" || !id) return "(none)";
  return id.slice(0, 4) + "****";
}

/** Lowercase letters and digits only, so "Seeds," and "seeds" compare equal. */
export function normalizeWord(word) {
  return String(word).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

export function sameText(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
