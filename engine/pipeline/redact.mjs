// Burn-in redaction: blur named rectangles of a video, permanently.
//
// The problem this solves: a screen recording of an app dashboard is useful teaching footage
// and risky to publish. Names, phone numbers and email addresses can sit in frame for the whole
// take. Redaction has to happen BEFORE anything is published, and it has to be verifiable.
//
// Split of responsibility:
//   redact.mjs      decides WHERE to blur and builds the ffmpeg argv. Pure, unit-tested.
//   ffmpeg          does the pixels.
//   pii-scan.mjs    proves the result, by OCR, fail-closed. It is the gate, not this.
//
// STATIC REGIONS, NOT DETECTED WORDS. It is tempting to OCR each frame and blur the boxes
// around whatever matched a PII pattern. That is the wrong default, for a reason worth writing
// down: OCR that fails to read a phone number also fails to blur it, so every OCR miss becomes
// a leak, and the failure is silent. A static pane covers the contact list whether or not this
// frame's text was legible and whether the list scrolled. Coordinates are cheap to author once
// per screen layout; a leak is not cheap at all.
//
// BLUR, NOT A BLACK BOX. Both are one filter. Blur keeps the shape of the interface so a viewer
// still follows what is being demonstrated. Use `mode: "box"` where the content must also look
// unrecoverable to a human reviewer rather than merely unreadable.
//
// Usage:
//   npm run redact -- --video out/take.mp4 --regions brand-props/regions.json \
//        [--out out/take.redacted.mp4] [--scan] [--fps 0.5] [--scan-scale 3] [--crf 18]
//
// A regions file is a JSON array (or {regions:[...]}) of rectangles in SOURCE pixels:
//   [{ "label": "contact list", "x": 30, "y": 55, "width": 1250, "height": 905 },
//    { "label": "address bar", "x": 700, "y": 20, "width": 1180, "height": 100, "mode": "box" }]
//
// Paths must be inside this repository and the output file must not exist yet. `--scan` runs the
// pii-scan gate on the OUTPUT (it needs the optional OCR engine described in pii-scan.mjs) and
// exits non-zero unless it comes back clean, so "redacted" and "verified redacted" are not the
// same claim made twice.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertInsideRoot, main } from "./runtime.mjs";

/** Blur strength and encode defaults. Overridable per call. */
export const REDACT_DEFAULTS = {
  /** Luma box radius. Big enough that 12px UI text is gone, not merely soft. */
  lumaRadius: 20,
  /** Passes. Two applications of a box blur approximate a gaussian well enough. */
  lumaPower: 2,
  /** Rate factor for the redacted output. Lower than the encoder default: this file
   *  replaces the source for every later step, so it should not be the lossy link. */
  crf: 18,
};

/**
 * THE RADIUS TRAP, which can cost a whole encode to discover. boxblur requires a radius of
 * at most (plane - 1) / 2 , HALF the plane, not the plane , and in yuv420p the chroma
 * planes are themselves half the region's width and height. So a 150x45 region caps
 * chroma at 10, and a 1880x150 region caps luma at 74. Exceed either and ffmpeg accepts
 * the command, runs, and then exits with "Invalid luma_param radius value ... must be
 * >= 0 and < 75", leaving a ZERO-BYTE output file. Both bounds are computed from the
 * region's own dimensions so a small region blurs correctly rather than failing the run.
 *
 * @param {number} planeW
 * @param {number} planeH
 * @returns {number} the largest radius ffmpeg will accept for a plane this size
 */
function radiusLimit(planeW, planeH) {
  return Math.max(1, Math.floor((Math.min(planeW, planeH) - 1) / 2));
}

/**
 * Legal chroma radius for a region, accounting for 4:2:0 subsampling.
 * @param {number} width region width in source pixels
 * @param {number} height region height in source pixels
 * @param {number} desired the radius we would use given unlimited room
 */
export function chromaRadiusFor(width, height, desired) {
  return Math.min(desired, radiusLimit(Math.floor(width / 2), Math.floor(height / 2)));
}

/** Legal luma radius for a region (full-resolution plane, same halved bound). */
export function lumaRadiusFor(width, height, desired) {
  return Math.min(desired, radiusLimit(width, height));
}

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Validate and normalize the authored regions against the real frame size.
 *
 * Fails loudly rather than clamping silently in one specific case: a region that is
 * entirely outside the frame. That means the coordinates were authored against a
 * different resolution, and every other region in the file is then also wrong , which
 * would otherwise surface as a video that looks redacted but is not.
 *
 * A region that merely OVERHANGS the frame is clamped, because "cover the right edge"
 * is a reasonable thing to express as an over-wide rectangle.
 *
 * @param {unknown} raw parsed regions file contents
 * @param {{ width: number, height: number }} frame source dimensions
 * @returns {{ regions: {label: string, x: number, y: number, width: number, height: number, mode: "blur"|"box"}[], notes: string[] }}
 */
export function planRegions(raw, frame) {
  const wrapper = /** @type {{ regions?: unknown }} */ (raw ?? {});
  const list = Array.isArray(raw) ? raw : Array.isArray(wrapper.regions) ? wrapper.regions : null;
  if (!list) throw new Error("regions must be a JSON array, or an object with a `regions` array");
  if (list.length === 0) throw new Error("regions is empty , a redaction pass that blurs nothing is a no-op, not a redaction");
  if (!isFiniteNumber(frame?.width) || !isFiniteNumber(frame?.height) || frame.width <= 0 || frame.height <= 0) {
    throw new Error("frame dimensions are required to validate regions");
  }

  const regions = [];
  const notes = [];

  list.forEach((r, i) => {
    const label = typeof r?.label === "string" && r.label.trim() !== "" ? r.label.trim() : `region ${i + 1}`;
    for (const k of ["x", "y", "width", "height"]) {
      if (!isFiniteNumber(r?.[k])) throw new Error(`${label}: ${k} must be a finite number`);
    }
    if (r.width <= 0 || r.height <= 0) throw new Error(`${label}: width and height must be positive`);
    if (r.mode !== undefined && r.mode !== "blur" && r.mode !== "box") {
      throw new Error(`${label}: mode must be "blur" or "box"`);
    }

    if (r.x >= frame.width || r.y >= frame.height || r.x + r.width <= 0 || r.y + r.height <= 0) {
      throw new Error(
        `${label} lies entirely outside the ${frame.width}x${frame.height} frame ` +
          `(x=${r.x} y=${r.y} w=${r.width} h=${r.height}). The regions were almost certainly ` +
          `authored against a different resolution, which means the others are wrong too.`
      );
    }

    // Clamp an overhang to the frame.
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    const width = Math.min(Math.round(r.width) + Math.min(0, Math.round(r.x)), frame.width - x);
    const height = Math.min(Math.round(r.height) + Math.min(0, Math.round(r.y)), frame.height - y);
    if (width !== Math.round(r.width) || height !== Math.round(r.height)) {
      notes.push(`${label}: clamped to the frame (${width}x${height} at ${x},${y})`);
    }
    // Odd dimensions break chroma subsampling on the crop; round down to even.
    const w = width - (width % 2);
    const h = height - (height % 2);
    if (w < 2 || h < 2) throw new Error(`${label}: too small to redact after clamping (${w}x${h})`);

    regions.push({ label, x, y, width: w, height: h, mode: r.mode === "box" ? "box" : "blur" });
  });

  return { regions, notes };
}

/**
 * Build the -filter_complex string that redacts every region in one pass.
 *
 * Shape: split the source once into a base plus one branch per region, crop each branch
 * to its rectangle, blur (or flatten) it, then overlay it back at the same coordinates.
 * One pass, one re-encode , chaining N ffmpeg invocations would re-encode N times and
 * compound artifacts on footage that is already a screen capture.
 *
 * @param {{label: string, x: number, y: number, width: number, height: number, mode: "blur"|"box"}[]} regions
 * @param {{ lumaRadius?: number, lumaPower?: number }} [opts]
 * @returns {string}
 */
export function buildFilter(regions, opts = {}) {
  if (!Array.isArray(regions) || regions.length === 0) throw new Error("buildFilter needs at least one region");
  const lumaWanted = opts.lumaRadius ?? REDACT_DEFAULTS.lumaRadius;
  const power = opts.lumaPower ?? REDACT_DEFAULTS.lumaPower;

  const branches = regions.map((_, i) => `[c${i}]`).join("");
  const parts = [`[0:v]split=${regions.length + 1}[base]${branches}`];

  regions.forEach((r, i) => {
    const crop = `crop=${r.width}:${r.height}:${r.x}:${r.y}`;
    // "box" flattens to a single colour by blurring at the maximum legal radius, so it
    // needs no second filter and inherits the same chroma bound.
    const luma = r.mode === "box" ? lumaRadiusFor(r.width, r.height, 1e9) : lumaRadiusFor(r.width, r.height, lumaWanted);
    const chroma = chromaRadiusFor(r.width, r.height, r.mode === "box" ? 1e9 : Math.ceil(lumaWanted / 2));
    const blur = `boxblur=luma_radius=${luma}:luma_power=${r.mode === "box" ? 3 : power}:chroma_radius=${chroma}:chroma_power=1`;
    parts.push(`[c${i}]${crop},${blur}[b${i}]`);
  });

  // Overlay each blurred patch back, threading the result of one into the next.
  regions.forEach((r, i) => {
    const under = i === 0 ? "[base]" : `[t${i - 1}]`;
    const out = i === regions.length - 1 ? "[out]" : `[t${i}]`;
    parts.push(`${under}[b${i}]overlay=${r.x}:${r.y}${out}`);
  });

  return parts.join(";");
}

/**
 * The full argv for the redaction pass.
 *
 * Audio is stream-copied: a redaction pass has no business re-encoding sound, and a
 * copy is both faster and lossless. `-map 0:a?` keeps a silent source working.
 *
 * @param {string} input absolute input path
 * @param {string} output absolute output path
 * @param {{label: string, x: number, y: number, width: number, height: number, mode: "blur"|"box"}[]} regions
 * @param {{ crf?: number, lumaRadius?: number, lumaPower?: number }} [opts]
 * @returns {string[]}
 */
export function redactArgs(input, output, regions, opts = {}) {
  return [
    "-nostdin",
    "-n", // never overwrite an existing file
    "-i", input,
    "-filter_complex", buildFilter(regions, opts),
    "-map", "[out]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", String(opts.crf ?? REDACT_DEFAULTS.crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    output,
  ];
}

/**
 * Read a video's frame size, so regions can be validated against reality rather than
 * against what the author believed the resolution was.
 *
 * @param {string} videoPath
 * @returns {{ width: number, height: number }}
 */
export function probeFrame(videoPath) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", resolve(videoPath)],
    { encoding: "utf-8" }
  );
  const s = JSON.parse(out)?.streams?.[0];
  if (!isFiniteNumber(s?.width) || !isFiniteNumber(s?.height)) {
    throw new Error(`could not read frame dimensions from ${videoPath}`);
  }
  return { width: s.width, height: s.height };
}

/** Load a regions file (array or {regions:[...]}). */
export function loadRegions(path) {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

/**
 * Redact a video end to end: probe, validate, blur, and optionally prove it with the
 * OCR gate.
 *
 * @param {object} input
 * @param {string} input.videoPath
 * @param {string} input.outPath
 * @param {unknown} input.regions parsed regions (array or {regions})
 * @param {boolean} [input.scan] run pii-scan on the OUTPUT and report its verdict
 * @param {number} [input.fps] frame sampling rate for the scan
 * @param {number} [input.scanScale] upscale factor for the scan's OCR. Leave at 1 for
 *   full-screen landscape footage; raise to 3 for vertical shorts, where the demo is
 *   scaled into a band and 1x OCR cannot read it at all (it returns a meaningless clean).
 * @param {number} [input.crf]
 * @returns {Promise<{ outPath: string, regions: any[], notes: string[], scan?: any }>}
 */
export async function redactVideo({ videoPath, outPath, regions: rawRegions, scan = false, fps = 0.5, scanScale = 1, crf }) {
  const input = resolve(videoPath);
  const output = resolve(outPath);
  if (existsSync(output)) throw new Error("Output already exists. Choose a new name or inspect the previous run.");
  const frame = probeFrame(input);
  const { regions, notes } = planRegions(rawRegions, frame);

  execFileSync("ffmpeg", redactArgs(input, output, regions, { crf }), { stdio: ["ignore", "ignore", "pipe"] });

  if (!scan) return { outPath: output, regions, notes };

  // Import lazily: the gate pulls in a WASM OCR engine, and a redaction run that was
  // not asked to verify should not pay for loading it.
  const { scanForPII } = await import("./pii-scan.mjs");
  const report = await scanForPII({ videoPath: output, fps, ocrScale: scanScale });
  return { outPath: output, regions, notes, scan: report };
}

// --- CLI ---
/** Parse `--name value` and `--switch` pairs. Unknown flags are refused. */
export function parseRedactArgs(argv) {
  const values = new Set(["video", "regions", "out", "fps", "scan-scale", "crf"]);
  const out = { scan: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--scan") { out.scan = true; continue; }
    if (!flag.startsWith("--") || !values.has(flag.slice(2))) throw new Error("Unknown argument " + flag + ". See the header of redact.mjs.");
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(flag + " needs a value");
    out[flag.slice(2)] = value;
  }
  return out;
}

async function redactCommand(argv) {
  const args = parseRedactArgs(argv);
  if (!args.video || !args.regions) {
    throw new Error("usage: npm run redact -- --video in.mp4 --regions regions.json [--out out.mp4] [--scan] [--fps 0.5] [--scan-scale 3] [--crf 18]");
  }
  const videoPath = assertInsideRoot(args.video, "--video");
  const regionsPath = assertInsideRoot(args.regions, "--regions");
  const outPath = assertInsideRoot(args.out ?? args.video.replace(/\.(mp4|mov|mkv|webm)$/i, "") + ".redacted.mp4", "--out");

  const result = await redactVideo({
    videoPath,
    outPath,
    regions: loadRegions(regionsPath),
    scan: args.scan,
    fps: args.fps === undefined ? 0.5 : Number(args.fps),
    scanScale: args["scan-scale"] === undefined ? 1 : Number(args["scan-scale"]),
    crf: args.crf === undefined ? REDACT_DEFAULTS.crf : Number(args.crf),
  });

  console.log(`redacted ${result.regions.length} region(s) -> ${result.outPath}`);
  for (const r of result.regions) console.log(`  ${r.mode}: ${r.label} (${r.width}x${r.height} at ${r.x},${r.y})`);
  for (const n of result.notes) console.log(`  note: ${n}`);

  if (!result.scan) {
    // "It ran" and "it is safe to publish" are different claims; the difference is this flag.
    console.log("NOT VERIFIED: re-run with --scan (or run pii-scan.mjs) before publishing");
    return;
  }
  const s = result.scan;
  if (s.cannotVerify) {
    console.error(`CANNOT VERIFY: ${s.cannotVerify}`);
    process.exitCode = 2;
    return;
  }
  for (const n of s.notes) console.log(`  note: ${n}`);
  if (!s.clean) {
    const byType = s.findings.reduce((a, f) => ((a[f.type] = (a[f.type] || 0) + 1), a), {});
    console.error(`STILL FOUND PII after redaction (${s.findings.length}): ${JSON.stringify(byType)}`);
    for (const f of s.findings.slice(0, 20)) console.error(`   [${f.source}${f.at ? " " + f.at : ""}] ${f.type}: ${f.match}`);
    console.error("Widen the regions that cover those areas and run again with a new --out.");
    process.exitCode = 1;
    return;
  }
  console.log("PII gate: CLEAN");
  // The gate has no person-NAME detector, so say so every time.
  console.log("note: names are not detectable by pattern; a person should still skim the output");
}

main(import.meta.url, redactCommand);
