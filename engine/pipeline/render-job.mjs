// One render from a props file, with optional source download and optional publish.
//
// Local-first. With no --out, the result stays in out/ and nothing leaves your machine.
// Everything below the render is ADVANCED and opt-in:
//
//   --source <uri>   fetch the media into public/ first (see storage.mjs for the schemes)
//   --out <uri>      copy the finished file to a destination URI
//   --publish        required in addition to --out when the destination is not file://, because
//                    uploading to a bucket or a drive is an external write you approve on purpose
//
// Props are validated against engine/compositions.mjs before the render starts, so a typo
// fails in seconds instead of after a long encode. A fetched source is wired into the right
// prop automatically (footage, audio or image, read from the registry).
//
// Usage:
//   npm run render:job -- --composition LessonVideo --props brand-props/job.json [--tag name]
//   npm run render:job -- --composition CourseCover --props brand-props/cover.json --tag cover
//
// Advanced (needs the matching CLI and your own credentials, see storage.mjs):
//   ... --source s3://my-bucket/raw/take.mp4 --out s3://my-bucket/renders --publish
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { COMPOSITIONS, COMPOSITION_IDS } from "../compositions.mjs";
import { REMOTION_ENTRY } from "./paths.mjs";
import { assertInsideRoot, assertNew, main, outputDirectory, readJson, render, slugSchema } from "./runtime.mjs";
import { fetchToFile, isRemoteUri, joinUri, localName, printableUri, publishFile } from "./storage.mjs";
import { assertValidProps } from "./validate-props.mjs";
import { z } from "zod";

const VALUE_FLAGS = ["composition", "props", "source", "out", "tag"];
const SWITCH_FLAGS = ["publish"];
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URI_SHAPE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Parse `--flag value` pairs and bare switches. Strict on purpose: an unknown flag is an
 * intention that would be silently ignored while the job succeeded at the wrong thing.
 *
 * @param {string[]} argv
 * @param {string[]} known flags that take a value
 * @param {string[]} [switches] flags that take no value; they parse to "true"
 * @returns {Record<string, string>}
 */
export function parseArgs(argv, known, switches = []) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error("unexpected argument " + JSON.stringify(token) + ": flags take the form --name value");
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (switches.includes(flag)) {
      if (eq !== -1) throw new Error("--" + flag + " takes no value");
      out[flag] = "true";
      continue;
    }
    if (!known.includes(flag)) {
      throw new Error("unknown flag --" + flag + " (known: " + [...known, ...switches].map((k) => "--" + k).join(", ") + ")");
    }
    // Both `--flag=value` and `--flag value` work.
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
      throw new Error("--" + flag + " needs a value");
    }
    out[flag] = value;
  }
  return out;
}

/**
 * Which prop a fetched source file belongs in, read from the composition's own schema:
 * footage for LessonVideo, an audio track for CaptionedShort, and so on.
 *
 * @param {string} compositionId
 * @returns {"videoSrc" | "audio" | "image" | null}
 */
export function sourceProp(compositionId) {
  const props = COMPOSITIONS[compositionId]?.props ?? {};
  for (const candidate of /** @type {const} */ (["videoSrc", "audio", "image"])) {
    if (candidate in props) return candidate;
  }
  return null;
}

/** @param {string} compositionId */
export function isStill(compositionId) {
  return COMPOSITIONS[compositionId]?.still === true;
}

/**
 * Decide what happens to the finished file, and refuse an upload nobody approved.
 *
 * @param {{ out?: string, publish?: string }} args
 * @returns {{ mode: "local" | "copy" | "upload", target?: string }}
 */
export function planDelivery({ out, publish }) {
  if (!out) {
    if (publish) throw new Error("--publish needs --out: there is nothing to publish to.");
    return { mode: "local" };
  }
  if (!URI_SHAPE.test(out)) {
    throw new Error("--out must be a destination URI such as file:///... inside this repository, or s3://bucket/prefix.");
  }
  // joinUri with a placeholder name validates the scheme and the path without touching disk.
  const remote = isRemoteUri(joinUri(out, "placeholder.mp4"));
  if (!remote) return { mode: "copy", target: out };
  if (!publish) {
    throw new Error(
      "Refusing to upload to " + out + " without --publish. Uploading sends your render to an external service. " +
      "Review the file in out/ first, then re-run with --publish if you approve that exact destination."
    );
  }
  return { mode: "upload", target: out };
}

// Props are trusted input (they choose which media the browser reads), so they must be a
// reviewed file inside this repository, never fetched from a URI.
function loadProps(propsRef) {
  if (URI_SHAPE.test(propsRef)) {
    throw new Error("--props must be a path to a props JSON inside this repository, not a URI. Download and review it first.");
  }
  return readJson(assertInsideRoot(propsRef, "--props"), z.record(z.string(), z.unknown()));
}

export function renderJob(argv) {
  const args = parseArgs(argv, VALUE_FLAGS, SWITCH_FLAGS);
  const composition = args.composition;
  if (!composition) throw new Error("--composition is required (one of: " + COMPOSITION_IDS.join(", ") + ")");
  if (!COMPOSITION_IDS.includes(composition)) {
    throw new Error("unknown composition " + composition + " (known: " + COMPOSITION_IDS.join(", ") + ")");
  }
  if (!args.props) throw new Error("--props is required: a path to a props JSON inside this repository");

  // Refuse an unapproved upload before any work starts.
  const delivery = planDelivery(args);

  const tag = slugSchema.parse(args.tag || composition);
  const propsDir = outputDirectory("out/_props");
  const publicDir = outputDirectory("public");
  const outDir = outputDirectory("out");
  const still = isStill(composition);
  const outName = tag + (still ? ".png" : ".mp4");
  const outPath = join(outDir, outName);
  const propsPath = join(propsDir, tag + ".json");
  assertNew([outPath, propsPath]);

  const props = loadProps(args.props);

  // Pull the source into public/, where Remotion resolves relative media paths, and point the
  // composition at it. This overrides what the props file said: the props were written before
  // the source had a local name.
  if (args.source) {
    const prop = sourceProp(composition);
    if (!prop) throw new Error(composition + " takes no media source; drop --source (it renders from props alone)");
    const name = localName(args.source);
    if (!SAFE_NAME.test(name)) throw new Error("The source file name " + JSON.stringify(name) + " is not portable; rename it to letters, digits, dot, dash or underscore.");
    console.log("fetching " + printableUri(args.source) + " -> public/" + name);
    fetchToFile(args.source, join(publicDir, name));
    props[prop] = name;
  }

  // The gate: a bad prop costs seconds here and the whole render otherwise.
  assertValidProps(composition, props);
  writeFileSync(propsPath, JSON.stringify(props), { flag: "wx" });

  console.log("rendering " + composition + " -> out/" + outName);
  render([still ? "still" : "render", REMOTION_ENTRY, composition, outPath, "--props=" + propsPath, ...(still ? [] : ["--codec=h264"])]);

  if (delivery.mode === "local") {
    console.log("Done. The file is in out/ and nothing was uploaded.");
    return;
  }
  const target = joinUri(delivery.target, outName);
  console.log((delivery.mode === "upload" ? "publishing (approved with --publish) -> " : "copying -> ") + printableUri(target));
  publishFile(outPath, target, { publish: delivery.mode === "upload" });
  console.log(target);
}

main(import.meta.url, renderJob);
