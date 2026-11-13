// Consent gate. Every clone command loads and checks a written consent record from the
// person being cloned before it reads media, calls a provider or writes an output.
// This is a workflow guard, not a legal form: it cannot make consent adequate under any law.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";
import { ROOT } from "../pipeline/runtime.mjs";
import { PRIVATE_DIR, isoDateSchema, localToday, nonEmptyText, sameText } from "./common.mjs";

export const consentSchema = z.object({
  schema: z.literal("clone-consent/1"),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Use 1-64 letters, digits, hyphens or underscores."),
  person: z.object({
    name: z.string().trim().min(2, "Write the cloned person's full name."),
    adultConfirmed: z.literal(true, "Clone only adults; confirm the person is 18 or older."),
  }).strict(),
  authorizes: z.object({ voice: z.boolean(), likeness: z.boolean() }).strict()
    .refine((value) => value.voice || value.likeness, "The record must authorize the voice, the likeness, or both."),
  scope: z.object({
    uses: z.array(nonEmptyText).min(1),
    excludedUses: z.array(nonEmptyText).default([]),
  }).strict(),
  platforms: z.array(nonEmptyText).min(1),
  aiDisclosure: z.object({
    acknowledged: z.literal(true, "The person must acknowledge the platform AI-disclosure rules."),
    note: z.string().optional(),
  }).strict(),
  signedOn: isoDateSchema,
  expires: z.union([isoDateSchema, z.literal("until-revoked")]),
  revocation: z.object({
    contact: nonEmptyText,
    revokedOn: isoDateSchema.nullable().default(null),
  }).strict(),
  recordedBy: nonEmptyText,
  method: z.enum(["signed-document", "written-message", "recorded-statement"]),
}).strict();

/**
 * Checks a parsed consent record against what a command is about to do.
 * needs: subset of ["voice", "likeness"]; use and platforms come from the job, when one is given.
 */
export function evaluateConsent(raw, { needs = [], today = localToday(), use, platforms = [] } = {}) {
  // The example's invented identity is refused too, so deleting the isExample line is not enough.
  if (raw && typeof raw === "object" && (raw.isExample || raw.id === "consent-example-001")) {
    throw new Error("This is the example consent template. Copy it into " + PRIVATE_DIR + "/consent/, replace every invented value with the real written record, and delete the isExample line.");
  }
  const record = consentSchema.parse(raw);
  const problems = [];
  if (record.signedOn > today) problems.push("it is dated in the future (" + record.signedOn + ")");
  if (record.expires !== "until-revoked" && record.expires < today) problems.push("it expired on " + record.expires);
  if (record.revocation.revokedOn) problems.push("it was revoked on " + record.revocation.revokedOn);
  for (const need of needs) {
    if (!record.authorizes[need]) problems.push("it does not authorize the " + need);
  }
  if (use !== undefined) {
    if (!record.scope.uses.some((allowed) => sameText(allowed, use))) problems.push("it does not list the use \"" + use + "\"");
    if (record.scope.excludedUses.some((excluded) => sameText(excluded, use))) problems.push("it excludes the use \"" + use + "\"");
  }
  for (const platform of platforms) {
    if (!record.platforms.some((allowed) => sameText(allowed, platform))) problems.push("it does not list the platform \"" + platform + "\"");
  }
  if (problems.length) throw new Error("Consent record " + record.id + " cannot be used: " + problems.join("; ") + ". Nothing was run.");
  return record;
}

/** Reads a consent record, which must sit inside the ignored clone-private folder. */
export function loadConsent(path, { root = ROOT } = {}) {
  if (typeof path !== "string" || !path) throw new Error("Pass --consent with the path to a written consent record in " + PRIVATE_DIR + "/consent/.");
  const privateRoot = resolve(root, PRIVATE_DIR);
  const absolute = resolve(root, path);
  const rel = relative(privateRoot, absolute);
  if (!rel || rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error("Keep consent records inside the ignored " + PRIVATE_DIR + "/ folder so they are never committed.");
  }
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error("Consent record not found, or not a regular file. Create it from engine/examples/clone-consent.example.json.");
  let raw;
  try { raw = JSON.parse(readFileSync(absolute, "utf8")); } catch { throw new Error("Consent record is not valid JSON."); }
  return raw;
}

export function requireConsent(path, options = {}) {
  return evaluateConsent(loadConsent(path, options), options);
}
