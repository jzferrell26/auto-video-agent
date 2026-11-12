// Locks the PII gate's core contract. Text scanning only (skipOcr), so it needs no ffmpeg,
// no OCR engine and no network.
import { test } from "vitest";
import assert from "node:assert/strict";
import { parsePiiArgs, scanForPII } from "../engine/pipeline/pii-scan.mjs";

test("flags an email and a phone number, and does not report clean", async () => {
  const r = await scanForPII({ texts: [{ label: "t", text: "reach me at test@example.com or 214-555-0182" }], skipOcr: true });
  assert.equal(r.clean, false);
  const types = r.findings.map((f) => f.type);
  assert.ok(types.includes("email"));
  assert.ok(types.includes("phone"));
});

test("reports clean on PII-free text", async () => {
  const r = await scanForPII({ texts: [{ label: "t", text: "How a workflow enrolls a contact in a sequence" }], skipOcr: true });
  assert.equal(r.clean, true);
});

test("redacts matches (never stores the raw value)", async () => {
  const r = await scanForPII({ texts: [{ label: "t", text: "email test@example.com" }], skipOcr: true });
  const email = r.findings.find((f) => f.type === "email");
  assert.ok(email);
  assert.ok(!email.match.includes("test@example.com"), "raw PII must not appear in the report");
  assert.ok(email.match.includes("*"), "match should be redacted with asterisks");
});

test("detects a street address, an IP address and a Luhn-valid card number", async () => {
  const text = "Visit 1200 Example Street or 192.168.10.20, card 4242 4242 4242 4242.";
  const r = await scanForPII({ texts: [{ label: "t", text }], skipOcr: true });
  const types = new Set(r.findings.map((f) => f.type));
  for (const type of ["address", "ip", "credit_card"]) assert.ok(types.has(type), type);
});

test("a card-shaped number that fails the Luhn check is not flagged", async () => {
  const r = await scanForPII({ texts: [{ label: "t", text: "order 1234 5678 9012 3456" }], skipOcr: true });
  assert.ok(!r.findings.some((f) => f.type === "credit_card"));
});

test("nothing scanned is cannotVerify, not clean (fail-open guard)", async () => {
  const r = await scanForPII({ texts: [], skipOcr: true });
  assert.equal(r.clean, false);
  assert.ok(r.cannotVerify, "empty input must report cannotVerify");
});

test("empty text entries do not count as scanned", async () => {
  const r = await scanForPII({ texts: [{ label: "a", text: "" }, { label: "b", text: null }], skipOcr: true });
  assert.ok(r.cannotVerify, "all-empty texts must report cannotVerify");
});

test("skipping OCR for a video never reports the result as verified", async () => {
  // ffmpeg is never reached: OCR is skipped, so only the text is read.
  const r = await scanForPII({ videoPath: "never-read.mp4", texts: [{ label: "t", text: "plain words" }], skipOcr: true });
  assert.equal(r.clean, true);
  assert.equal(r.verified, false);
});

test("skipping OCR when only text was given still counts as verified", async () => {
  const r = await scanForPII({ texts: [{ label: "t", text: "plain words" }], skipOcr: true });
  assert.equal(r.clean, true);
  assert.equal(r.verified, true);
});

test("frame OCR without the optional engine fails closed with an install hint", async () => {
  // A video path is given but OCR is on; without tesseract.js (not installed here) or ffmpeg
  // this must be cannotVerify, never clean. The path need not exist: the gate stops first.
  const r = await scanForPII({ videoPath: "does-not-exist.mp4", fps: 1 });
  assert.equal(r.clean, false);
  assert.equal(r.verified, false);
  assert.ok(r.cannotVerify);
});

test("fps and ocr-scale must be plain bounded numbers", async () => {
  await assert.rejects(scanForPII({ texts: [{ label: "t", text: "x" }], fps: Number.NaN, skipOcr: true }), /--fps/);
  await assert.rejects(scanForPII({ texts: [{ label: "t", text: "x" }], ocrScale: 99, skipOcr: true }), /--ocr-scale/);
});

test("argument parsing refuses unknown flags and missing values", () => {
  assert.deepEqual(parsePiiArgs(["--video", "out/a.mp4", "--skip-ocr"]), { video: "out/a.mp4", skipOcr: true });
  assert.throws(() => parsePiiArgs(["--vidoe", "a.mp4"]), /Unknown argument/);
  assert.throws(() => parsePiiArgs(["--video"]), /needs a value/);
});

test("a JSON transcript in an unexpected shape is still scanned", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "pii-shape-"));
  try {
    const path = join(dir, "odd.json");
    writeFileSync(path, JSON.stringify({ text: "reach me at test@example.com" }));
    const r = await scanForPII({ transcriptPath: path });
    assert.equal(r.clean, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
