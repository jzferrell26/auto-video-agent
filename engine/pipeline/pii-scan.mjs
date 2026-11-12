// Pre-publish PII gate. Scans a video's transcript AND sampled frames for personally
// identifiable information (emails, phone numbers, SSNs, credit cards, IPs, street
// addresses) and FAILS CLOSED: exit 1 if anything is found, exit 2 if it cannot verify
// (for example OCR was requested but the OCR engine is not installed). Nothing should be
// published without a clean pass.
//
// Usage:
//   npm run pii:scan -- --video out/lesson.mp4 [--transcript _sources/take.transcript.txt] \
//        [--fps 1] [--ocr-scale 3] [--out out/pii-report.json] [--skip-ocr]
//
// --ocr-scale is not optional tuning. At 1x this gate cannot read small UI text: a vertical
// short whose screen recording is scaled into a band can come back CLEAN with a phone number
// plainly visible, because OCR only ever saw the headline. Raise it to 2-3 for anything where
// the risk is interface text, and lower --fps to pay for it.
//
// OCR is OPTIONAL and is not a dependency of this repository. To scan frames or images, install
// it once without saving it to package.json:   npm install --no-save tesseract.js
// tesseract.js runs in-process (WASM) but may download its language data on first use. Without
// it, a frame scan stops with exit 2 and an install hint; it never reports a false "clean".
// The transcript and text scans need neither OCR nor network. ffmpeg must be on PATH for frames.
// Matches are REDACTED in the report so the report is not itself a PII store.
//
// Programmatic:
//   import { scanForPII } from "./pii-scan.mjs";
//   const { clean, findings } = await scanForPII({ videoPath, transcriptPath, fps });
//
// A regex gate cannot see person NAMES. A clean result means no structured PII was read, so a
// person should still skim the footage before it is published.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { assertInsideRoot, main } from "./runtime.mjs";

// --- PII detectors. Each returns redacted matches, never the raw value. ---
const DETECTORS = [
  { type: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  // US phone: 555-123-4567, (555) 123-4567, +1 555 123 4567, 5551234567
  { type: "phone", re: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, validate: (m) => (m.replace(/\D/g, "").length >= 10) },
  { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "ip", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { type: "credit_card", re: /\b(?:\d[ -]?){13,19}\b/g, validate: luhn },
  // street address: number + words + street suffix
  { type: "address", re: /\b\d{1,6}\s+([A-Za-z0-9.'-]+\s){1,4}(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl|circle|cir|terrace|ter)\b/gi },
];

function luhn(s) {
  const d = s.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function redact(s) {
  const t = s.trim();
  if (t.length <= 4) return "*".repeat(t.length);
  return t.slice(0, 2) + "*".repeat(Math.max(2, t.length - 4)) + t.slice(-2);
}

function scanText(text, source, at) {
  const findings = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of text.matchAll(d.re)) {
      const val = m[0];
      if (d.validate && !d.validate(val)) continue;
      findings.push({ source, at, type: d.type, match: redact(val) });
    }
  }
  return findings;
}

function loadTranscript(p) {
  const raw = readFileSync(p, "utf-8");
  if (p.endsWith(".json")) {
    try {
      const j = JSON.parse(raw);
      // words.json / segments.json shapes: [{word|text}] or {segments:[{text}]}
      const arr = Array.isArray(j) ? j : (j.segments || j.words || []);
      return arr.map((x) => x.word || x.text || "").join(" ");
    } catch { return raw; }
  }
  return raw;
}

function have(bin) {
  try { execFileSync(bin, ["-version"], { stdio: "ignore" }); return true; }
  catch { try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }
}

/**
 * @param {object} input
 * @param {string} [input.videoPath] video to sample frames from for on-screen OCR
 * @param {string} [input.transcriptPath] transcript file to text-scan
 * @param {{ label: string, text?: string | null }[]} [input.texts] in-memory strings to scan
 * @param {string[]} [input.imagePaths] images to OCR (thumbnails, covers)
 * @param {number} [input.fps] frame sampling rate for video OCR
 * @param {number} [input.ocrScale] upscale frames by this factor before OCR. THE GATE IS
 *   BLIND TO SMALL TEXT AT 1x. A vertical short with a screen recording scaled into a band
 *   can read only its headline at native size and come back clean while a phone number sits
 *   visible in the demo; the same frame at 3x can find it. Use 2-3 whenever the risky text is
 *   interface text rather than titles. Costs OCR time
 *   quadratically, so drop `fps` when you raise this.
 * @param {boolean} [input.skipOcr] text-only mode; reduces safety, never reports verified
 * @returns {Promise<{ clean: boolean, verified: boolean, cannotVerify?: string, findings: any[], notes: string[] }>}
 */
export async function scanForPII({ videoPath, transcriptPath, texts = [], imagePaths = [], fps = 1, ocrScale = 1, skipOcr = false }) {
  // These values are placed in an ffmpeg filter string, so they must be plain positive numbers.
  if (!Number.isFinite(Number(fps)) || Number(fps) <= 0 || Number(fps) > 30) throw new Error("--fps must be a number above 0 and at most 30.");
  if (!Number.isFinite(Number(ocrScale)) || Number(ocrScale) < 1 || Number(ocrScale) > 4) throw new Error("--ocr-scale must be a number from 1 to 4.");
  const findings = [];
  const notes = [];
  // Track whether anything was actually inspected. A gate that scanned nothing must NOT report
  // "clean" (that is fail-open); it returns cannotVerify instead.
  let scanned = false;

  if (transcriptPath) {
    findings.push(...scanText(loadTranscript(resolve(transcriptPath)), "transcript", null));
    scanned = true;
  }

  // Inline strings to scan (e.g. the title + description that will be PUBLISHED as metadata).
  for (const t of texts) {
    if (t && t.text) { findings.push(...scanText(String(t.text), t.label || "text", null)); scanned = true; }
  }

  // OCR (on-screen PII) via tesseract.js (WASM, NO system install). ffmpeg is still used to
  // sample video frames; only the OCR engine is in-process. Skipped when skipOcr is set.
  const needFrameOcr = Boolean(videoPath) && !skipOcr;
  const needImageOcr = imagePaths.length > 0 && !skipOcr;
  if (skipOcr) {
    if (videoPath) notes.push("OCR skipped (--skip-ocr): on-screen PII NOT verified");
    if (imagePaths.length) notes.push(`OCR skipped for ${imagePaths.length} image(s): on-screen PII NOT verified`);
  }

  if (needFrameOcr || needImageOcr) {
    if (needFrameOcr && !have("ffmpeg")) return fail("ffmpeg missing; cannot sample frames", findings, notes);
    let worker;
    try {
      // A variable specifier keeps bundlers and test runners from trying to resolve an
      // optional package that is deliberately not installed by default.
      const engine = "tesseract.js";
      const t = await import(/* @vite-ignore */ engine);
      worker = await (t.createWorker ? t.createWorker("eng") : t.default.createWorker("eng"));
    } catch (e) {
      return fail(`OCR engine unavailable: tesseract.js not installed (install it with: npm install --no-save tesseract.js). ${errText(e)}`.trim(), findings, notes);
    }
    const dir = needFrameOcr ? mkdtempSync(join(tmpdir(), "piiscan-")) : null;
    try {
      if (needFrameOcr && dir && videoPath) {
        const scale = Number(ocrScale) > 1 ? `,scale=iw*${ocrScale}:ih*${ocrScale}:flags=lanczos` : "";
        execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", resolve(videoPath), "-vf", `fps=${fps}${scale}`, join(dir, "f-%05d.png")], { stdio: "ignore" });
        const frames = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
        // Fail closed: exit 0 from ffmpeg with no frames means we verified nothing on-screen.
        if (frames.length === 0) return fail(`ffmpeg produced 0 frames from ${videoPath}; cannot verify on-screen PII`, findings, notes);
        for (let i = 0; i < frames.length; i++) {
          const { data } = await worker.recognize(join(dir, frames[i]));
          findings.push(...scanText(data.text || "", "frame", `${(i / fps).toFixed(1)}s`));
        }
        scanned = true;
        notes.push(
          `OCR scanned ${frames.length} frames at ${fps} fps` +
            (Number(ocrScale) > 1 ? `, upscaled ${ocrScale}x` : ", NO upscale (small UI text may be unreadable)") +
            ` (tesseract.js)`
        );
      }
      for (const img of imagePaths) {
        const { data } = await worker.recognize(resolve(img));
        findings.push(...scanText(data.text || "", "image", img));
        scanned = true;
      }
      if (imagePaths.length) notes.push(`OCR scanned ${imagePaths.length} image(s) (tesseract.js)`);
    } catch (e) {
      return fail(`OCR failed: ${errText(e) || String(e)}`, findings, notes);
    } finally {
      try { await worker.terminate(); } catch {}
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  // Nothing inspected at all is a fail-open; report it as unverifiable rather than clean.
  if (!scanned) return fail("no scannable input was inspected (empty text and no video / transcript / images)", findings, notes);

  return { clean: findings.length === 0, verified: !skipOcr, findings, notes };
}

/** Safe message from an unknown thrown value. */
function errText(e) {
  return e instanceof Error ? e.message : "";
}

function fail(reason, findings, notes) {
  return { clean: false, verified: false, cannotVerify: reason, findings, notes };
}

// --- CLI ---
/** Parse `--name value` and `--switch` pairs. Unknown flags are refused. */
export function parsePiiArgs(argv) {
  const values = new Set(["video", "transcript", "fps", "ocr-scale", "out"]);
  const out = { skipOcr: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--skip-ocr") { out.skipOcr = true; continue; }
    if (!flag.startsWith("--") || !values.has(flag.slice(2))) throw new Error("Unknown argument " + flag + ". See the header of pii-scan.mjs.");
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(flag + " needs a value");
    out[flag.slice(2)] = value;
  }
  return out;
}

async function piiCommand(argv) {
  let args;
  try { args = parsePiiArgs(argv); } catch (e) { console.error(errText(e)); process.exitCode = 2; return; }
  if (!args.video && !args.transcript) {
    console.error("Provide --video and/or --transcript. See the header of pii-scan.mjs.");
    process.exitCode = 2;
    return;
  }
  try {
    const report = await scanForPII({
      videoPath: args.video && assertInsideRoot(args.video, "--video"),
      transcriptPath: args.transcript && assertInsideRoot(args.transcript, "--transcript"),
      fps: args.fps === undefined ? 1 : Number(args.fps),
      ocrScale: args["ocr-scale"] === undefined ? 1 : Number(args["ocr-scale"]),
      skipOcr: args.skipOcr,
    });
    // The report holds redacted matches only. It is written once and never overwrites.
    if (args.out) writeFileSync(assertInsideRoot(args.out, "--out"), JSON.stringify(report, null, 2), { flag: "wx" });
    const byType = report.findings.reduce((a, f) => ((a[f.type] = (a[f.type] || 0) + 1), a), {});
    console.log(report.cannotVerify ? `CANNOT VERIFY: ${report.cannotVerify}` : (report.clean ? "PII gate: CLEAN" : "PII gate: FOUND PII"));
    for (const n of report.notes) console.log(`  note: ${n}`);
    if (report.findings.length) {
      console.log(`  findings (${report.findings.length}): ${JSON.stringify(byType)}`);
      for (const f of report.findings.slice(0, 20)) console.log(`   [${f.source}${f.at ? " " + f.at : ""}] ${f.type}: ${f.match}`);
      if (report.findings.length > 20) console.log(`   ... and ${report.findings.length - 20} more`);
    }
    // Fail closed: 0 clean, 1 found PII, 2 cannot verify.
    process.exitCode = report.cannotVerify ? 2 : (report.clean ? 0 : 1);
  } catch (e) {
    console.error(errText(e) || "PII scan failed.");
    process.exitCode = 2;
  }
}

main(import.meta.url, piiCommand);
