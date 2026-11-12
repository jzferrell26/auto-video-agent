// Locks redaction planning and the ffmpeg argv.
// The failure modes here are the expensive kind: a filter that ffmpeg rejects after
// accepting the command (zero-byte output), and regions authored against the wrong
// resolution (a video that looks redacted and is not).
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildFilter,
  chromaRadiusFor,
  lumaRadiusFor,
  planRegions,
  redactArgs,
  REDACT_DEFAULTS,
  parseRedactArgs,
} from "../engine/pipeline/redact.mjs";

const FRAME = { width: 1920, height: 1080 };
const R = (over = {}) => ({ label: "contact list", x: 30, y: 55, width: 1250, height: 904, ...over });

// ---------------------------------------------------------------------------
// the radius trap
//
// Both bounds are (plane - 1) / 2, and chroma's plane is itself halved by 4:2:0.
// These numbers came from ffmpeg's own rejection messages on a real encode; exceeding
// either produces a zero-byte file after a full pass, so they are locked here.
// ---------------------------------------------------------------------------

test("chroma radius stays under half the 4:2:0 subsampled plane", () => {
  // 150x45 region -> 75x22 chroma plane -> max radius 10.
  assert.equal(chromaRadiusFor(150, 45, 25), 10);
});

test("chroma radius matches the bound ffmpeg reported for a 250x100 region", () => {
  // ffmpeg: "Invalid chroma_param radius value 25, must be >= 0 and < 25" -> max 24.
  assert.equal(chromaRadiusFor(250, 100, 1e9), 24);
});

test("chroma radius passes a wanted value through when there is room", () => {
  assert.equal(chromaRadiusFor(1250, 904, 10), 10);
});

test("chroma radius is never zero, even for a tiny region", () => {
  assert.equal(chromaRadiusFor(4, 4, 25), 1);
  assert.ok(chromaRadiusFor(2, 2, 25) >= 1);
});

test("luma radius matches the bound ffmpeg reported for a 1880x150 region", () => {
  // ffmpeg: "Invalid luma_param radius value 149, must be >= 0 and < 75" -> max 74.
  assert.equal(lumaRadiusFor(1880, 150, 1e9), 74);
});

test("luma radius is bounded by half the full-resolution plane", () => {
  assert.equal(lumaRadiusFor(1250, 904, 20), 20);
  assert.equal(lumaRadiusFor(10, 6, 20), 2);
  assert.ok(lumaRadiusFor(2, 2, 20) >= 1);
});

// ---------------------------------------------------------------------------
// region validation
// ---------------------------------------------------------------------------

test("accepts a plain array and an object with a regions key", () => {
  assert.equal(planRegions([R()], FRAME).regions.length, 1);
  assert.equal(planRegions({ regions: [R()] }, FRAME).regions.length, 1);
});

test("labels an unlabelled region by index rather than leaving it blank", () => {
  const { regions } = planRegions([{ x: 0, y: 0, width: 100, height: 100 }], FRAME);
  assert.equal(regions[0].label, "region 1");
});

test("defaults mode to blur and accepts box", () => {
  const { regions } = planRegions([R(), R({ label: "url", mode: "box" })], FRAME);
  assert.equal(regions[0].mode, "blur");
  assert.equal(regions[1].mode, "box");
});

test("rejects an empty region list , a redaction that blurs nothing is not a redaction", () => {
  assert.throws(() => planRegions([], FRAME), /empty/);
  assert.throws(() => planRegions({ regions: [] }, FRAME), /empty/);
});

test("rejects a non-array regions value", () => {
  assert.throws(() => planRegions({ x: 0 }, FRAME), /must be a JSON array/);
  assert.throws(() => planRegions("nope", FRAME), /must be a JSON array/);
});

test("rejects non-finite and non-positive geometry, naming the region", () => {
  assert.throws(() => planRegions([R({ x: NaN })], FRAME), /contact list: x must be a finite number/);
  assert.throws(() => planRegions([R({ width: 0 })], FRAME), /width and height must be positive/);
  assert.throws(() => planRegions([R({ height: -10 })], FRAME), /width and height must be positive/);
});

test("rejects an unknown mode rather than silently blurring", () => {
  assert.throws(() => planRegions([R({ mode: "pixelate" })], FRAME), /mode must be/);
});

// The load-bearing one: coordinates authored for another resolution.
test("rejects a region entirely outside the frame, because the others are then wrong too", () => {
  assert.throws(() => planRegions([R({ x: 2400 })], FRAME), /lies entirely outside/);
  assert.throws(() => planRegions([R({ y: 2000 })], FRAME), /different resolution/);
});

test("clamps a region that merely overhangs the frame, and says it did", () => {
  const { regions, notes } = planRegions([R({ x: 1880, width: 400 })], FRAME);
  assert.equal(regions[0].x, 1880);
  assert.equal(regions[0].width, 40);
  assert.match(notes[0], /clamped to the frame/);
});

test("region dimensions come out even, so the crop's chroma plane is valid", () => {
  const { regions } = planRegions([R({ width: 101, height: 55 })], FRAME);
  assert.equal(regions[0].width % 2, 0);
  assert.equal(regions[0].height % 2, 0);
});

test("requires real frame dimensions", () => {
  assert.throws(() => planRegions([R()], { width: 0, height: 1080 }), /frame dimensions/);
  assert.throws(() => planRegions([R()], /** @type {any} */ (undefined)), /frame dimensions/);
});

// ---------------------------------------------------------------------------
// filter construction
// ---------------------------------------------------------------------------

test("splits into a base plus one branch per region", () => {
  const { regions } = planRegions([R(), R({ label: "b", x: 1400 })], FRAME);
  const f = buildFilter(regions);
  assert.match(f, /\[0:v\]split=3\[base\]\[c0\]\[c1\]/);
});

test("crops and overlays each region at the same coordinates", () => {
  const { regions } = planRegions([R()], FRAME);
  const f = buildFilter(regions);
  assert.match(f, /\[c0\]crop=1250:904:30:55,/);
  assert.match(f, /\[base\]\[b0\]overlay=30:55\[out\]/);
});

test("threads multiple overlays through intermediate labels, ending at out", () => {
  const { regions } = planRegions([R(), R({ label: "b", x: 1400 }), R({ label: "c", x: 1700 })], FRAME);
  const f = buildFilter(regions);
  assert.match(f, /\[base\]\[b0\]overlay=30:55\[t0\]/);
  assert.match(f, /\[t0\]\[b1\]overlay=1400:55\[t1\]/);
  assert.match(f, /\[t1\]\[b2\]overlay=1700:55\[out\]/);
  // Exactly one terminal label, or ffmpeg maps the wrong stream.
  assert.equal((f.match(/\[out\]/g) ?? []).length, 1);
});

test("every emitted radius is legal for its own region, in both planes", () => {
  // A tall thin region and a short wide one, in both modes: the bound that matters is
  // the SMALLER dimension, and box mode asks for the maximum.
  const { regions } = planRegions(
    [
      R({ label: "thin", x: 0, y: 0, width: 40, height: 900 }),
      R({ label: "short", x: 100, y: 0, width: 900, height: 44, mode: "box" }),
    ],
    FRAME
  );
  const f = buildFilter(regions);
  const emitted = [...f.matchAll(/luma_radius=(\d+):luma_power=\d+:chroma_radius=(\d+)/g)];
  assert.equal(emitted.length, 2);

  const legal = (w, h, luma, chroma) => {
    assert.ok(luma <= (Math.min(w, h) - 1) / 2, `luma ${luma} illegal for ${w}x${h}`);
    const cw = Math.floor(w / 2);
    const ch = Math.floor(h / 2);
    assert.ok(chroma <= (Math.min(cw, ch) - 1) / 2, `chroma ${chroma} illegal for ${cw}x${ch}`);
  };
  legal(40, 900, Number(emitted[0][1]), Number(emitted[0][2]));
  legal(900, 44, Number(emitted[1][1]), Number(emitted[1][2]));
});

test("box mode blurs harder than blur mode", () => {
  const { regions } = planRegions([R({ mode: "box" })], FRAME);
  const box = buildFilter(regions);
  const { regions: soft } = planRegions([R()], FRAME);
  const blur = buildFilter(soft);
  const radiusOf = (s) => Number((/luma_radius=(\d+)/.exec(s) ?? [])[1]);
  assert.ok(radiusOf(box) > radiusOf(blur));
  assert.match(box, /luma_power=3/);
});

test("an overridden luma radius reaches the filter", () => {
  const { regions } = planRegions([R()], FRAME);
  assert.match(buildFilter(regions, { lumaRadius: 8 }), /luma_radius=8/);
});

test("buildFilter refuses an empty list", () => {
  assert.throws(() => buildFilter([]), /at least one region/);
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

test("argv maps the filtered video and copies audio without re-encoding", () => {
  const { regions } = planRegions([R()], FRAME);
  const args = redactArgs("/in.mp4", "/out.mp4", regions);
  assert.equal(args[args.length - 1], "/out.mp4");
  assert.equal(args[args.indexOf("-i") + 1], "/in.mp4");
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2), ["-map", "[out]"]);
  // `0:a?` , the ? keeps a silent source working.
  assert.ok(args.includes("0:a?"));
  assert.deepEqual(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2), ["-c:a", "copy"]);
});

test("argv defaults to the near-lossless crf and honours an override", () => {
  const { regions } = planRegions([R()], FRAME);
  assert.equal(redactArgs("/in.mp4", "/o.mp4", regions)[redactArgs("/in.mp4", "/o.mp4", regions).indexOf("-crf") + 1], String(REDACT_DEFAULTS.crf));
  const custom = redactArgs("/in.mp4", "/o.mp4", regions, { crf: 12 });
  assert.equal(custom[custom.indexOf("-crf") + 1], "12");
});

test("argv never overwrites and never waits for input, so an unattended run cannot clobber or hang", () => {
  const { regions } = planRegions([R()], FRAME);
  const args = redactArgs("/in.mp4", "/o.mp4", regions);
  assert.ok(args.includes("-n"));
  assert.ok(args.includes("-nostdin"));
  assert.ok(!args.includes("-y"));
});

test("argument parsing refuses unknown flags and missing values", () => {
  assert.deepEqual(parseRedactArgs(["--video", "a.mp4", "--regions", "r.json", "--scan"]), { video: "a.mp4", regions: "r.json", scan: true });
  assert.throws(() => parseRedactArgs(["--vidoe", "a.mp4"]), /Unknown argument/);
  assert.throws(() => parseRedactArgs(["--video"]), /needs a value/);
});
