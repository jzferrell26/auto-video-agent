// Private config (provider ids), per-piece job files and look state. Ids never live in the
// repository: they come from CLI arguments or the ignored clone-private/ folder.
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { ROOT } from "../pipeline/runtime.mjs";
import { PRIVATE_DIR, aliasSchema, isoDateSchema, nonEmptyText, providerIdSchema } from "./common.mjs";
import { RESOLUTIONS, SPEED_RANGE, TTS_MODELS, VIDEO_ENGINES } from "./heygen.mjs";

export const CONFIG_FILE = PRIVATE_DIR + "/config.json";
export const STATE_FILE = PRIVATE_DIR + "/state.json";

const lookSchema = z.object({
  avatarId: providerIdSchema,
  orientation: z.enum(["portrait", "landscape"]),
  faceX: z.number().min(0).max(1).default(0.5),
}).strict();

export const configSchema = z.object({
  schema: z.literal("clone-config/1"),
  voice: z.object({
    voiceId: providerIdSchema,
    model: z.enum(TTS_MODELS).default("heygen-voice-1"),
    speed: z.number().min(SPEED_RANGE.min).max(SPEED_RANGE.max).optional(),
    language: z.string().regex(/^[a-z]{2}$/, "Use a two-letter language code such as en.").optional(),
  }).strict(),
  looks: z.record(aliasSchema, lookSchema).refine((looks) => Object.keys(looks).length > 0, "Add at least one look."),
  video: z.object({
    resolution: z.enum(RESOLUTIONS).default("1080p"),
    engine: z.enum(VIDEO_ENGINES).optional(),
  }).strict().default({ resolution: "1080p" }),
}).strict();

const timingAnchor = {
  atMs: z.number().int().nonnegative().optional(),
  atPhrase: nonEmptyText.optional(),
};
const kickerSpec = z.object({
  ...timingAnchor,
  durMs: z.number().int().positive().max(600000),
  text: nonEmptyText,
}).strict().refine((kicker) => (kicker.atMs === undefined) !== (kicker.atPhrase === undefined), "Give each kicker atMs or atPhrase, not both.");

const brollSpec = z.object({
  src: z.string(),
  fromPhrase: nonEmptyText.optional(),
  toPhrase: nonEmptyText.optional(),
  atMs: z.number().int().nonnegative().optional(),
  durMs: z.number().int().positive().max(600000).optional(),
  leadMs: z.number().int().nonnegative().max(2000).default(60),
  tailMs: z.number().int().nonnegative().max(2000).default(120),
  sourceFrom: z.number().int().nonnegative().default(0),
  sourceWidth: z.number().int().min(16),
  sourceHeight: z.number().int().min(16),
  crop: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() }).strict(),
  eyebrow: z.string().max(80).optional(),
  whoosh: z.boolean().default(false),
}).strict().refine((clip) => (clip.fromPhrase !== undefined && clip.toPhrase !== undefined && clip.atMs === undefined && clip.durMs === undefined)
  || (clip.fromPhrase === undefined && clip.toPhrase === undefined && clip.atMs !== undefined && clip.durMs !== undefined),
"Anchor each B-roll clip with fromPhrase and toPhrase, or with atMs and durMs.");

export const jobSchema = z.object({
  schema: z.literal("clone-job/1"),
  use: nonEmptyText,
  platforms: z.array(nonEmptyText).min(1),
  scriptApprovedOn: isoDateSchema,
  script: z.string().trim().min(1).max(10000),
  language: z.string().regex(/^[a-z]{2}$/, "Use a two-letter language code such as en.").optional(),
  emphasis: z.array(nonEmptyText).default([]),
  kickers: z.array(kickerSpec).default([]),
  broll: z.array(brollSpec).default([]),
  brollWidth: z.object({ min: z.number().int().min(160), max: z.number().int().max(1920) }).strict()
    .refine((range) => range.min <= range.max, "Width range minimum must not exceed its maximum.").optional(),
  centerX: z.number().min(0).max(1).default(0.5),
  zoom: z.number().positive().max(4).default(1),
  spliced: z.object({
    theme: z.record(z.string().regex(/^[A-Za-z]{1,32}$/), z.string().max(200)).optional(),
    captionY: z.number().nonnegative().optional(),
    wordsPerPage: z.number().int().min(1).max(12).optional(),
    tailMs: z.number().nonnegative().max(60000).optional(),
    safeArea: z.object({ top: z.number().min(0).max(0.25).optional(), bottom: z.number().min(0.5).max(0.9).optional() }).strict().optional(),
  }).strict().default({}),
}).strict();

export const stateSchema = z.object({
  schema: z.literal("clone-state/1"),
  lastLook: aliasSchema,
  updatedOn: isoDateSchema,
}).strict();

function readJsonFile(absolute, label) {
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return undefined;
  try { return JSON.parse(readFileSync(absolute, "utf8")); } catch { throw new Error(label + " is not valid JSON."); }
}

function insideRoot(root, path, label) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || resolve(rel) === rel) throw new Error(label + " must be inside the repository.");
  return absolute;
}

export function loadConfig({ root = ROOT, required = true } = {}) {
  const raw = readJsonFile(join(root, CONFIG_FILE), "The private config");
  if (raw === undefined) {
    if (required) throw new Error("Create " + CONFIG_FILE + " from engine/examples/clone-config.example.json and fill in your own ids.");
    return undefined;
  }
  if (JSON.stringify(raw).includes("replace-with-")) throw new Error(CONFIG_FILE + " still has placeholder values. Fill in your own voice and look ids.");
  return configSchema.parse(raw);
}

export function loadJob(path, { root = ROOT } = {}) {
  if (typeof path !== "string" || !path) throw new Error("Pass --job with the path to the piece's job file (keep real jobs in brand-props/).");
  const raw = readJsonFile(insideRoot(root, path, "The job file"), "The job file");
  if (raw === undefined) throw new Error("Job file not found. Start from engine/examples/clone-job.example.json.");
  return jobSchema.parse(raw);
}

export function loadState({ root = ROOT } = {}) {
  const raw = readJsonFile(join(root, STATE_FILE), "The look state");
  return raw === undefined ? undefined : stateSchema.parse(raw);
}

/** Replaces the look state atomically. The state holds a look name only, never an id. */
export function saveState(state, { root = ROOT } = {}) {
  const value = stateSchema.parse(state);
  const target = join(root, STATE_FILE);
  const temp = target + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  renameSync(temp, target);
  return value;
}
