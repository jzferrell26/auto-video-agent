// Build every course lesson for one session from a lesson map.
// For each lesson: ffmpeg frame-accurate clip -> rebased captions -> LessonVideo render.
//
// Usage: node build-lessons.mjs <sessionVideo> <wordsJson> <lessonMapJson> <slug>
//
// The lesson map supplies content AND brand:
//   { module, theme?, logo?, lessons: [{ number, title, inSec, outSec }] }
// theme/logo are optional; a neutral default is used if omitted. Brand is an
// INPUT, nothing here is tied to a specific account or client.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Resolve the Remotion CLI JS entry; invoke via `node` (no shell, Windows-safe).
const projectRequire = createRequire(resolve(root, "package.json"));
const remotionCliPkg = projectRequire.resolve("@remotion/cli/package.json");
const remotionCliBin = (() => {
  const pkg = JSON.parse(readFileSync(remotionCliPkg, "utf-8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.remotion;
  return resolve(dirname(remotionCliPkg), rel);
})();

// Neutral default brand. Override per job via the lesson map's `theme` / `logo`.
const DEFAULT_THEME = { cream: "#f4f4f5", slate: "#18181b", teal: "#3f6f6a", gold: "#c2a45f", sage: "#8a8a94" };

const sessionVideo = process.argv[2];
const wordsJson = process.argv[3];
const lessonMapJson = process.argv[4];
const slug = process.argv[5] || "session";

const map = JSON.parse(readFileSync(resolve(root, lessonMapJson), "utf-8"));
const words = JSON.parse(readFileSync(resolve(root, wordsJson), "utf-8"));
const theme = map.theme || DEFAULT_THEME;
const logo = map.logo; // undefined -> no logo

mkdirSync(resolve(root, "public/lessons"), { recursive: true });
mkdirSync(resolve(root, "brand-props"), { recursive: true });
mkdirSync(resolve(root, "out/lessons"), { recursive: true });

const ffprobeDuration = (file) =>
  parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file])
      .toString()
      .trim()
  );

for (const lesson of map.lessons) {
  const tag = `${slug}-L${String(lesson.number).padStart(2, "0")}`;
  const clipRel = `lessons/${tag}.mp4`;
  const clipAbs = resolve(root, "public", clipRel);
  console.log(`\n=== ${tag}: ${lesson.title} (${lesson.inSec}s -> ${lesson.outSec}s) ===`);

  execFileSync(
    "ffmpeg",
    ["-y", "-ss", String(lesson.inSec), "-to", String(lesson.outSec), "-i", resolve(root, sessionVideo),
     "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", clipAbs],
    { cwd: root, stdio: "ignore" }
  );
  const clipSeconds = ffprobeDuration(clipAbs);

  const startMs = lesson.inSec * 1000;
  const endMs = lesson.outSec * 1000;
  const captions = words
    .filter((w) => w.startMs >= startMs && w.startMs < endMs)
    .map((w) => ({ word: w.word, startMs: w.startMs - startMs, endMs: w.endMs - startMs }));

  const props = {
    theme, logo,
    moduleTitle: map.module, lessonNumber: lesson.number, lessonTitle: lesson.title,
    videoSrc: clipRel, captions, clipSeconds, introSeconds: 3, outroSeconds: 2.6, wordsPerPage: 4,
  };
  const propsPath = resolve(root, "brand-props", `${tag}.json`);
  writeFileSync(propsPath, JSON.stringify(props));
  const outPath = resolve(root, "out/lessons", `${tag}.mp4`);

  execFileSync(
    process.execPath,
    [remotionCliBin, "render", "src/index.tsx", "LessonVideo", outPath, `--props=${propsPath}`, "--codec=h264"],
    { cwd: root, stdio: "inherit" }
  );
  console.log(`  -> ${outPath} (${clipSeconds.toFixed(0)}s clip, ${captions.length} caption words)`);
}

console.log(`\nAll ${map.lessons.length} lessons for ${slug} complete.`);
