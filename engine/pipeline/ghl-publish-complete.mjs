// Render cover + thumbnails, upload cover + thumbnails + lesson videos to GoHighLevel
// media, then import a COMPLETE draft course. One command per session.
//
// Usage: node ghl-publish-complete.mjs <lessonMapJson> <slug>
// Requires env: GHL_LOCATION_ID, GHL_PIT (a sub-account Private Integration Token with
// courses.write + medias.write). Nothing is tied to a specific account: location + token
// come from the environment, brand + content come from the lesson map.
//
// The lesson map must include: courseTitle, courseDescription, module, coverEyebrow,
// coverSubtitle, instructor{name,description}, theme?, logo?, lessons[]{number,title,desc}.
// Everything imports as DRAFT; nothing publishes automatically.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://services.leadconnectorhq.com";

const LOCATION_ID = process.env.GHL_LOCATION_ID;
const PIT = process.env.GHL_PIT;
if (!LOCATION_ID || !PIT) {
  console.error("Set GHL_LOCATION_ID and GHL_PIT in your environment (see .env.example).");
  process.exit(1);
}

const req = createRequire(resolve(root, "package.json"));
const cliPkg = req.resolve("@remotion/cli/package.json");
const cliJson = JSON.parse(readFileSync(cliPkg, "utf-8"));
const REMOTION = resolve(dirname(cliPkg), typeof cliJson.bin === "string" ? cliJson.bin : cliJson.bin.remotion);

const DEFAULT_THEME = { cream: "#f4f4f5", slate: "#18181b", teal: "#3f6f6a", gold: "#c2a45f", sage: "#8a8a94" };

const mapPath = process.argv[2];
const slug = process.argv[3];
const map = JSON.parse(readFileSync(resolve(root, mapPath), "utf-8"));
const theme = map.theme || DEFAULT_THEME;

const still = (comp, props, out, frame) =>
  execFileSync(process.execPath, [REMOTION, "still", "src/index.tsx", comp, out, `--props=${props}`, `--frame=${frame}`], { cwd: root, stdio: "ignore" });

// 1. Render cover + thumbnails.
console.log("=== rendering cover + thumbnails ===");
const coverProps = resolve(root, "brand-props", `cover-${slug}.json`);
writeFileSync(coverProps, JSON.stringify({ theme, logo: map.logo, eyebrow: map.coverEyebrow, title: map.courseTitle, subtitle: map.coverSubtitle }));
const coverPng = resolve(root, "out", `cover-${slug}.png`);
still("CourseCover", coverProps, coverPng, 40);
for (const l of map.lessons) {
  const p = resolve(root, "brand-props", `${slug}-L${String(l.number).padStart(2, "0")}.json`);
  const out = resolve(root, "out/thumbs", `${slug}-L${String(l.number).padStart(2, "0")}.png`);
  still("LessonVideo", p, out, 55);
}

// 2. Upload helper.
async function upload(path, name, type) {
  const fd = new FormData();
  fd.set("file", new Blob([readFileSync(path)], { type }), name);
  fd.set("name", name);
  const r = await fetch(`${BASE}/medias/upload-file`, { method: "POST", headers: { Authorization: `Bearer ${PIT}`, Version: "v3" }, body: fd });
  const j = await r.json();
  if (!r.ok || !j.url) throw new Error(`upload ${name} failed: ${r.status} ${JSON.stringify(j)}`);
  return j.url;
}

console.log("=== uploading cover + videos + thumbnails ===");
const coverUrl = await upload(coverPng, `${slug}-cover.png`, "image/png");
const posts = [];
for (const l of map.lessons) {
  const nn = String(l.number).padStart(2, "0");
  const videoUrl = await upload(resolve(root, "out/lessons", `${slug}-L${nn}.mp4`), `${slug}-L${nn}.mp4`, "video/mp4");
  const thumbUrl = await upload(resolve(root, "out/thumbs", `${slug}-L${nn}.png`), `${slug}-L${nn}-thumb.png`, "image/png");
  console.log(`  L${l.number} video + thumb uploaded`);
  posts.push({ title: l.title, visibility: "draft", contentType: "video", description: l.desc, thumbnailUrl: thumbUrl, bucketVideoUrl: videoUrl });
}

// 3. Import complete (draft).
const payload = {
  locationId: LOCATION_ID,
  products: [{
    title: map.courseTitle,
    description: map.courseDescription,
    imageUrl: coverUrl,
    categories: [{ title: map.module, visibility: "draft", thumbnailUrl: coverUrl, posts }],
    instructorDetails: map.instructor,
  }],
};
console.log("=== importing COMPLETE course (draft) ===");
const r = await fetch(`${BASE}/courses/courses-exporter/public/import`, {
  method: "POST",
  headers: { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.log("HTTP", r.status);
console.log(JSON.stringify(await r.json(), null, 2));
