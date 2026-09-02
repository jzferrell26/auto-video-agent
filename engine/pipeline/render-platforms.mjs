// One trusted brief, three local outputs. Does not upload or publish.
import { join } from "node:path";
import { assertNew, main, outputDirectory, readJson, render, shortSchema, slugSchema, writeJson } from "./runtime.mjs";

export function renderPlatforms(args) {
  if (args.includes("--help")) {
    console.log("Usage: npm run render:platforms -- <brief.json> <new-slug>");
    return;
  }
  if (args.length !== 2) throw new Error("Expected brief JSON and a new slug. Use --help.");
  const content = readJson(args[0], shortSchema);
  const slug = slugSchema.parse(args[1]);
  const output = outputDirectory("out");
  const props = outputDirectory("out/_props");
  const jobs = [
    { name: "9x16", width: 1080, height: 1920 },
    { name: "1x1", width: 1080, height: 1080 },
    { name: "16x9", width: 1920, height: 1080 },
  ].map((target) => ({
    ...target, output: join(output, slug + "-" + target.name + ".mp4"),
    props: join(props, slug + "-" + target.name + ".json"),
  }));
  assertNew(jobs.flatMap((job) => [job.output, job.props]));
  for (const job of jobs) {
    writeJson(job.props, { ...content, width: job.width, height: job.height });
    render(["render", "src/index.tsx", "BrandedShort", job.output, "--props=" + job.props, "--codec=h264"]);
  }
  console.log("Rendered all three aspect ratios. No uploads were made.");
}
main(import.meta.url, renderPlatforms);
