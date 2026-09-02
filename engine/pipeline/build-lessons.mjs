// Local-only course builder. Relative paths are resolved from the repository root.
import { resolve, join } from "node:path";
import { ROOT, assertNew, main, mapSchema, outputDirectory, readJson, rebaseWords, render, run, slugSchema, wordsSchema, writeJson } from "./runtime.mjs";

export function buildLessons(args) {
  if (args.includes("--help")) {
    console.log("Usage: npm run build:lessons -- <video> <words.json> <map.json> <new-slug>");
    return;
  }
  if (args.length !== 4) throw new Error("Expected video, words JSON, lesson map JSON and a new slug. Use --help.");
  const [video, wordsPath, mapPath, rawSlug] = args;
  const slug = slugSchema.parse(rawSlug);
  const map = readJson(mapPath, mapSchema);
  const words = readJson(wordsPath, wordsSchema);
  const source = resolve(ROOT, video);
  const duration = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source], { stdio: "pipe" }).toString().trim());
  if (!Number.isFinite(duration) || map.lessons.some((lesson) => lesson.outSec > duration + 0.05)) {
    throw new Error("A lesson extends beyond the source duration, or duration is unreadable.");
  }
  const clips = outputDirectory("public/lessons");
  const props = outputDirectory("brand-props");
  const output = outputDirectory("out/lessons");
  const jobs = map.lessons.map((lesson) => {
    const tag = slug + "-L" + String(lesson.number).padStart(2, "0");
    return { lesson, tag, clip: join(clips, tag + ".mp4"), props: join(props, tag + ".json"), output: join(output, tag + ".mp4") };
  });
  assertNew(jobs.flatMap((job) => [job.clip, job.props, job.output]));
  for (const job of jobs) {
    const { lesson } = job;
    run("ffmpeg", ["-nostdin", "-n", "-ss", String(lesson.inSec), "-i", source, "-t", String(lesson.outSec - lesson.inSec),
      "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
      "-c:a", "aac", "-movflags", "+faststart", job.clip]);
    writeJson(job.props, {
      theme: map.theme, logo: map.logo, moduleTitle: map.module, lessonNumber: lesson.number,
      lessonTitle: lesson.title, videoSrc: "lessons/" + job.tag + ".mp4",
      captions: rebaseWords(words, lesson.inSec, lesson.outSec),
      clipSeconds: lesson.outSec - lesson.inSec, introSeconds: 3, outroSeconds: 2.6, wordsPerPage: 4,
    });
    render(["render", "src/index.tsx", "LessonVideo", job.output, "--props=" + job.props, "--codec=h264"]);
  }
  console.log("Rendered " + jobs.length + " lesson(s) to out/lessons. No uploads were made.");
}
main(import.meta.url, buildLessons);
