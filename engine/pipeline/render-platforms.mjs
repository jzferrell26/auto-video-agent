// Render one brief to every platform aspect ratio (per-platform is a handoff hard rule).
// Single-sources the brief content; injects width/height per target.
//
// Usage: node scripts/render-platforms.mjs [contentPropsPath] [slug]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Resolve the Remotion CLI's JS entry from the project root and run it with `node`
// directly (execFileSync, no shell). This is shell-injection-safe (args are an argv
// array, never a command string) AND avoids the Windows `.cmd` spawn EINVAL that
// `npx` / `npx.cmd` hits under Node's no-shell restriction on spawning .cmd files.
const projectRequire = createRequire(resolve(root, "package.json"));
const remotionCliPkg = projectRequire.resolve("@remotion/cli/package.json");
const remotionCliBin = (() => {
  const pkg = JSON.parse(readFileSync(remotionCliPkg, "utf-8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.remotion;
  return resolve(dirname(remotionCliPkg), rel);
})();

const contentPath = resolve(root, process.argv[2] || "brand-props/short.json");
const slug = process.argv[3] || "short";

const PLATFORMS = [
  { name: "9x16", width: 1080, height: 1920 }, // Reels / TikTok / Shorts
  { name: "1x1", width: 1080, height: 1080 }, // Feed
  { name: "16x9", width: 1920, height: 1080 }, // YouTube / landscape
];

const content = JSON.parse(readFileSync(contentPath, "utf-8"));
const outDir = resolve(root, "out");
const tmpDir = resolve(outDir, "_props");
mkdirSync(tmpDir, { recursive: true });

for (const p of PLATFORMS) {
  const propsPath = resolve(tmpDir, `${slug}-${p.name}.json`);
  writeFileSync(propsPath, JSON.stringify({ ...content, width: p.width, height: p.height }, null, 2));
  const outPath = resolve(outDir, `${slug}-${p.name}.mp4`);
  console.log(`\n=== ${p.name} (${p.width}x${p.height}) -> ${outPath} ===`);
  // execFileSync with an argv array (no shell): a slug or path containing shell
  // metacharacters (quotes, $(), backticks, ;) can never break out and inject a
  // command. Closes the shell-injection surface for a future server-invoked service.
  execFileSync(
    process.execPath,
    [
      remotionCliBin,
      "render",
      "src/index.tsx",
      "BrandedShort",
      outPath,
      `--props=${propsPath}`,
      "--codec=h264",
    ],
    { cwd: root, stdio: "inherit" }
  );
}

console.log("\nAll platform renders complete.");
