import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(join(ROOT, "package.json"));
export const slugSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "Use 1-64 letters, digits, hyphens or underscores.");
const themeSchema = z.object({
  cream: z.string(), slate: z.string(), teal: z.string(), gold: z.string(), sage: z.string(),
}).partial().strict();
const lessonSchema = z.object({
  number: z.number().int().positive(), title: z.string().min(1), desc: z.string().default(""),
  inSec: z.number().finite().nonnegative(), outSec: z.number().finite().positive(),
}).refine((lesson) => lesson.outSec > lesson.inSec, "Lesson end must follow its start.");
export const mapSchema = z.object({
  module: z.string().min(1), theme: themeSchema.optional(), logo: z.string().min(1).optional(),
  lessons: z.array(lessonSchema).min(1).max(100),
}).passthrough().refine((map) => new Set(map.lessons.map((lesson) => lesson.number)).size === map.lessons.length, "Lesson numbers must be unique.");
export const deliveryMapSchema = mapSchema.and(z.object({
  courseTitle: z.string().min(1), courseDescription: z.string().min(1),
  coverEyebrow: z.string().optional(), coverSubtitle: z.string().optional(),
  instructor: z.object({ name: z.string().min(1), description: z.string() }).strict(),
}));
export const wordsSchema = z.array(z.object({
  word: z.string(), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative(),
}).refine((word) => word.endMs >= word.startMs, "Word end precedes start."));
const seconds = z.number().finite().min(0.5).max(3600);
export const shortSchema = z.object({
  theme: themeSchema.optional(), logo: z.string().min(1).optional(),
  width: z.number().int().positive().max(7680).optional(),
  height: z.number().int().positive().max(7680).optional(),
  scenes: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("intro"), eyebrow: z.string().optional(), headline: z.string().min(1), seconds }),
    z.object({ type: z.literal("statement"), eyebrow: z.string().optional(), headline: z.string().min(1), seconds }),
    z.object({ type: z.literal("truth"), text: z.string().min(1), seconds }),
    z.object({ type: z.literal("list"), eyebrow: z.string().optional(), items: z.array(z.string()).min(1), seconds }),
    z.object({ type: z.literal("outro"), quote: z.string().min(1), signoff: z.string(), seconds }),
  ])).min(1).max(100),
}).strict();

export function readJson(path, schema) {
  return schema.parse(JSON.parse(readFileSync(resolve(ROOT, path), "utf8")));
}

export function outputDirectory(subpath) {
  const path = resolve(ROOT, subpath);
  const rel = relative(ROOT, path);
  if (!rel || rel.startsWith("..") || resolve(subpath) === subpath) throw new Error("Output must be inside the repository.");
  let current = ROOT;
  for (const segment of rel.split(/[\\/]/)) {
    current = join(current, segment);
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) {
      throw new Error("Output directories must be real local directories.");
    }
    mkdirSync(current, { recursive: true });
  }
  return path;
}

export function assertNew(paths) {
  if (paths.some((path) => existsSync(path))) throw new Error("Output already exists. Choose a new slug or inspect the previous run.");
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
}

export function render(args) {
  const pkgPath = requireFromRoot.resolve("@remotion/cli/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.remotion;
  return run(process.execPath, [resolve(dirname(pkgPath), bin), ...args]);
}

export function rebaseWords(words, startSec, endSec) {
  const start = startSec * 1000;
  const end = endSec * 1000;
  return words.filter((word) => word.startMs >= start && word.startMs < end)
    .map((word) => ({ ...word, startMs: word.startMs - start, endMs: Math.min(word.endMs, end) - start }));
}

export function main(moduleUrl, callback) {
  if (process.argv[1] && moduleUrl === pathToFileURL(resolve(process.argv[1])).href) {
    Promise.resolve().then(() => callback(process.argv.slice(2))).catch((error) => {
      if (error instanceof z.ZodError) {
        console.error("Invalid input: " + error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "));
      } else {
        console.error(error instanceof Error ? error.message : "Command failed.");
      }
      process.exitCode = 1;
    });
  }
}
