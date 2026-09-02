// Explicitly gated external delivery. The default is a local-only preview.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT, assertNew, deliveryMapSchema, main, outputDirectory, readJson, render, slugSchema, writeJson } from "./runtime.mjs";

const BASE = "https://services.leadconnectorhq.com";
const envSchema = z.object({ GHL_LOCATION_ID: z.string().min(1), GHL_PIT: z.string().min(1) });
const uploadSchema = z.object({ url: z.url().refine((url) => url.startsWith("https://"), "Expected HTTPS media URL.") });
const importSchema = z.object({ processingCourses: z.array(z.object({ id: z.string().min(1) })).min(1) });

export function buildCoursePayload(map, locationId, coverUrl, posts) {
  return {
    locationId,
    products: [{
      title: map.courseTitle, description: map.courseDescription, imageUrl: coverUrl,
      categories: [{ title: map.module, visibility: "draft", thumbnailUrl: coverUrl,
        posts: posts.map((post) => ({ ...post, visibility: "draft" })) }],
      instructorDetails: map.instructor,
    }],
  };
}

export async function checkedJson(response, schema, operation) {
  // Provider errors can echo credentials or content. Never print their bodies.
  if (!response.ok) throw new Error(operation + " failed (HTTP " + response.status + "). Inspect the provider dashboard privately.");
  let value;
  try { value = await response.json(); } catch { throw new Error(operation + " returned non-JSON data."); }
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(operation + " returned an unexpected response. Inspect the provider dashboard before retrying.");
  return result.data;
}

export async function deliver(args) {
  if (args.includes("--help")) {
    console.log("Usage: npm run deliver:ghl -- <map.json> <slug> [--upload-and-import]\nWithout the flag: local preview only. With it: uploads media and creates a draft course. Manual dashboard verification is required.");
    return;
  }
  if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== "--upload-and-import")) {
    throw new Error("Expected map JSON, slug and optional --upload-and-import. Use --help.");
  }
  const map = readJson(args[0], deliveryMapSchema);
  const slug = slugSchema.parse(args[1]);
  if (!args.includes("--upload-and-import")) {
    console.log("DRY RUN: " + map.lessons.length + " lesson(s). No credentials read, renders, uploads or imports.\nRender and review lessons first; add --upload-and-import only to authorize external delivery.");
    return;
  }
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = envSchema.parse(process.env);
  // Validate ALL required local artifacts before any render or network operation.
  for (const lesson of map.lessons) {
    const tag = slug + "-L" + String(lesson.number).padStart(2, "0");
    for (const file of [join(ROOT, "out/lessons", tag + ".mp4"), join(ROOT, "brand-props", tag + ".json")]) {
      if (!statSync(file).isFile()) throw new Error("A required lesson artifact is missing.");
    }
  }
  const deliveryDir = outputDirectory("out/delivery");
  const directory = join(deliveryDir, slug);
  assertNew([directory]);
  outputDirectory("out/delivery/" + slug);
  // A partial attempt is deliberately not retried automatically, even after a process crash.
  writeJson(join(directory, "attempt.json"), { startedAt: new Date().toISOString(), state: "started", lessonCount: map.lessons.length });
  const coverProps = join(directory, "cover.json");
  const coverPng = join(directory, "cover.png");
  writeJson(coverProps, { theme: map.theme, logo: map.logo, eyebrow: map.coverEyebrow, title: map.courseTitle, subtitle: map.coverSubtitle });
  render(["still", "src/index.tsx", "CourseCover", coverPng, "--props=" + coverProps, "--frame=40"]);
  const jobs = map.lessons.map((lesson) => {
    const tag = slug + "-L" + String(lesson.number).padStart(2, "0");
    return { lesson, tag, thumbnail: join(directory, tag + ".png"), video: join(ROOT, "out/lessons", tag + ".mp4") };
  });
  for (const job of jobs) {
    render(["still", "src/index.tsx", "LessonVideo", job.thumbnail, "--props=" + join(ROOT, "brand-props", job.tag + ".json"), "--frame=55"]);
  }
  async function upload(file, name, type) {
    const data = new FormData();
    data.set("file", new Blob([readFileSync(file)], { type }), name);
    data.set("name", name);
    const response = await fetch(BASE + "/medias/upload-file", {
      method: "POST", headers: { Authorization: "Bearer " + env.GHL_PIT, Version: "v3" },
      body: data, signal: AbortSignal.timeout(300000), redirect: "error",
    });
    return (await checkedJson(response, uploadSchema, "Media upload")).url;
  }
  const coverUrl = await upload(coverPng, slug + "-cover.png", "image/png");
  const posts = [];
  for (const job of jobs) {
    posts.push({
      title: job.lesson.title, contentType: "video", description: job.lesson.desc,
      thumbnailUrl: await upload(job.thumbnail, job.tag + ".png", "image/png"),
      bucketVideoUrl: await upload(job.video, job.tag + ".mp4", "video/mp4"),
    });
  }
  const response = await fetch(BASE + "/courses/courses-exporter/public/import", {
    method: "POST", headers: { Authorization: "Bearer " + env.GHL_PIT, Version: "2021-07-28", "Content-Type": "application/json" },
    body: JSON.stringify(buildCoursePayload(map, env.GHL_LOCATION_ID, coverUrl, posts)),
    signal: AbortSignal.timeout(60000), redirect: "error",
  });
  const result = await checkedJson(response, importSchema, "Course import");
  writeJson(join(directory, "result.json"), { state: "accepted", processingCourseIds: result.processingCourses.map((course) => course.id) });
  console.log("Import accepted for asynchronous processing. Verify media, course contents and draft status in your dashboard. Nothing was auto-published.");
}
main(import.meta.url, deliver);
