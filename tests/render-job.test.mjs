// Locks the argument parsing and the registry-driven decisions a cloud render depends on.
//
// The render itself needs a browser and a source file, so it is not tested here. What IS
// tested is everything that decides *what* to render ; because those mistakes are the ones
// that produce a successful-looking run with the wrong output.
import { test } from "vitest";
import assert from "node:assert/strict";
import { COMPOSITION_IDS } from "../engine/compositions.mjs";
import { isStill, parseArgs, planDelivery, renderJob, sourceProp } from "../engine/pipeline/render-job.mjs";

const KNOWN = ["composition", "props", "source", "out", "tag"];

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

test("parses --flag value pairs", () => {
  assert.deepEqual(parseArgs(["--composition", "LessonVideo", "--props", "p.json"], KNOWN), {
    composition: "LessonVideo",
    props: "p.json",
  });
});

test("parses --flag=value, which is what workflow YAML produces", () => {
  assert.deepEqual(parseArgs(["--composition=LessonVideo", "--out=s3://b/renders"], KNOWN), {
    composition: "LessonVideo",
    out: "s3://b/renders",
  });
});

test("a URI value with :// survives intact", () => {
  const args = parseArgs(["--source", "r2://media/raw/ep12.mp4"], KNOWN);
  assert.equal(args.source, "r2://media/raw/ep12.mp4");
});

test("rejects an unknown flag rather than ignoring the intent behind it", () => {
  assert.throws(() => parseArgs(["--compsition", "LessonVideo"], KNOWN), /unknown flag --compsition/);
});

test("rejects a flag with no value, including one swallowed by the next flag", () => {
  assert.throws(() => parseArgs(["--props"], KNOWN), /--props needs a value/);
  assert.throws(() => parseArgs(["--props", "--out", "s3://b/x"], KNOWN), /--props needs a value/);
  assert.throws(() => parseArgs(["--props="], KNOWN), /--props needs a value/);
});

test("rejects a bare positional argument", () => {
  assert.throws(() => parseArgs(["LessonVideo"], KNOWN), /unexpected argument/);
});

test("an empty argv is valid ; the caller reports what is missing, with its own wording", () => {
  assert.deepEqual(parseArgs([], KNOWN), {});
});

// ---------------------------------------------------------------------------
// registry-driven decisions
// ---------------------------------------------------------------------------

test("a fetched source lands in the prop that composition actually reads", () => {
  assert.equal(sourceProp("LessonVideo"), "videoSrc");
  assert.equal(sourceProp("MicroClip"), "videoSrc");
  assert.equal(sourceProp("CaptionedShort"), "audio"); // audio-only: no footage prop exists
});

test("a composition that renders from props alone reports no source prop", () => {
  // Passing --source to these is a caller mistake worth naming, not a file to download and ignore.
  assert.equal(sourceProp("CourseCover"), null);
  assert.equal(sourceProp("BrandedShort"), null);
  assert.equal(sourceProp("SplicedShort"), null); // its footage lives in segments[].src
});

test("sourceProp on an unknown composition is null, not a crash", () => {
  assert.equal(sourceProp("NotAComposition"), null);
});

test("the only still is the course cover", () => {
  assert.deepEqual(COMPOSITION_IDS.filter(isStill), ["CourseCover"]);
});

test("every composition resolves a still/video decision without throwing", () => {
  for (const id of COMPOSITION_IDS) assert.equal(typeof isStill(id), "boolean");
});

// ---------------------------------------------------------------------------
// approval-first delivery
// ---------------------------------------------------------------------------

test("a switch flag parses without a value, and refuses one", () => {
  assert.deepEqual(parseArgs(["--publish", "--out", "s3://b/x"], KNOWN, ["publish"]), { publish: "true", out: "s3://b/x" });
  assert.throws(() => parseArgs(["--publish=yes"], KNOWN, ["publish"]), /takes no value/);
  assert.throws(() => parseArgs(["--publish"], KNOWN), /unknown flag --publish/);
});

test("with no --out, the result stays local", () => {
  assert.deepEqual(planDelivery({}), { mode: "local" });
});

test("--publish alone is an error, since there is nowhere to publish", () => {
  assert.throws(() => planDelivery({ publish: "true" }), /--publish needs --out/);
});

test("a remote --out without --publish is refused with a clear message", () => {
  for (const out of ["s3://bucket/renders", "r2://bucket/renders", "drive://Renders"]) {
    assert.throws(() => planDelivery({ out }), /Refusing to upload.*--publish/s);
  }
});

test("a remote --out with --publish is an approved upload", () => {
  assert.deepEqual(planDelivery({ out: "s3://bucket/renders", publish: "true" }), { mode: "upload", target: "s3://bucket/renders" });
});

test("a file:// --out is a local copy and needs no --publish", () => {
  assert.equal(planDelivery({ out: "file:///srv/copies" }).mode, "copy");
});

test("--out must be a URI, and plain http is refused", () => {
  assert.throws(() => planDelivery({ out: "some/folder" }), /destination URI/);
  assert.throws(() => planDelivery({ out: "http://example.com/x" }), /https/);
});

test("props must be a reviewed local file, never fetched from a URI", () => {
  assert.throws(() => renderJob(["--composition", "LessonVideo", "--props", "https://cdn.example.com/p.json"]), /not a URI/);
});
