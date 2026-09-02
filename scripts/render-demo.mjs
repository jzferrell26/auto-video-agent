import { mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, main, outputDirectory, render } from "../engine/pipeline/runtime.mjs";

main(import.meta.url, () => {
  const output = mkdtempSync(join(outputDirectory("out"), "demo-"));
  const video = join(output, "demo.mp4");
  render(["render", "src/index.tsx", "BrandedShort", video, "--props=engine/examples/demo-short.json", "--codec=h264", "--concurrency=2"]);
  console.log("Demo ready: " + relative(ROOT, video));
});
