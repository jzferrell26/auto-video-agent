// H.264 encoder selection: prefer a hardware encoder that actually works, else libx264.
//
// Why this exists, in two parts:
//
//  1. SPEED. The lesson pipeline encodes an intermediate clip per lesson before
//     Remotion renders. On a Mac that's `h264_videotoolbox`; on an NVIDIA box
//     `h264_nvenc`. Both are several times faster than libx264 for this step.
//
//  2. QUALITY. The intermediate is a *source* for a second lossy encode (Remotion's
//     h264 render). At libx264's default CRF 23 with `-preset veryfast` you compound
//     artifacts twice and lose detail Remotion can never get back. Every profile here
//     targets near-lossless instead, the intermediate is a scratch file, so spend
//     bits there and let the final render do the compressing.
//
// THE TRAP, and why selection is a trial rather than a lookup: `ffmpeg -encoders` lists
// encoders that were COMPILED IN, not encoders that can actually open on this machine.
// A stock Linux ffmpeg build advertises `h264_nvenc` on a box with no NVIDIA driver,
// then fails at encoder-open with "Cannot load libcuda.so.1", so trusting the list
// breaks every single clip. The only reliable test is to encode one tiny frame and see
// whether ffmpeg exits cleanly. That runs once per process and is cached.
import { execFileSync } from "node:child_process";

/**
 * Candidate order per platform. Hardware first, libx264 always last as the floor.
 * A candidate only gets used if it survives verifyEncoder().
 */
const PREFERENCE = {
  darwin: ["h264_videotoolbox", "libx264"],
  linux: ["h264_nvenc", "h264_qsv", "h264_vaapi", "libx264"],
  win32: ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"],
};

const FALLBACK_PREFERENCE = ["libx264"];

/**
 * Near-lossless quality settings per encoder. Each encoder spells "quality" its own
 * way, CRF is libx264-only, so the others get their equivalent knob rather than a
 * silently-ignored -crf flag.
 *
 * `crf` is the libx264 rate factor (lower = better); the hardware profiles are tuned
 * to sit in the same visual neighbourhood.
 */
export function encodeArgs(encoder, { crf = 16 } = {}) {
  switch (encoder) {
    case "libx264":
      // veryfast at a low CRF: still quick, but ~7 CRF steps better than the default.
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p"];

    case "h264_videotoolbox":
      // VideoToolbox has no CRF. -q:v is 1-100 (higher = better) and only applies in
      // constant-quality mode, which needs -b:v 0 to disable the bitrate target.
      return ["-c:v", "h264_videotoolbox", "-q:v", "65", "-b:v", "0", "-pix_fmt", "yuv420p"];

    case "h264_nvenc":
      // p5 = "slow" in NVENC's preset scale; -cq is its constant-quality factor.
      return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", String(crf + 2), "-b:v", "0", "-pix_fmt", "yuv420p"];

    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-global_quality", String(crf + 2), "-preset", "slow", "-pix_fmt", "nv12"];

    case "h264_amf":
      return ["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", String(crf), "-qp_p", String(crf), "-pix_fmt", "yuv420p"];

    case "h264_vaapi":
      // VAAPI needs frames uploaded to the GPU; the filter is part of the contract.
      return ["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", String(crf)];

    default:
      throw new Error(`encodeArgs: no quality profile for encoder "${encoder}"`);
  }
}

/**
 * Parse the encoder names out of `ffmpeg -encoders` output.
 * Lines look like: ` V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)`
 * The legend above them (` V..... = Video`) must not be mistaken for an encoder.
 */
export function parseEncoders(stdout) {
  const names = new Set();
  for (const line of String(stdout).split("\n")) {
    const m = /^\s*[VASFXBD.]{6}\s+([A-Za-z0-9_.-]+)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Candidates to try, in order: the platform's preference list filtered to what ffmpeg
 * claims to have. Being on this list means "worth trying", not "works".
 */
export function candidateEncoders(available, platform = process.platform) {
  const have = available instanceof Set ? available : new Set(available);
  const order = PREFERENCE[platform] ?? FALLBACK_PREFERENCE;
  return order.filter((name) => have.has(name));
}

/**
 * Walk the candidates and return the first that `verify` accepts.
 * `verify` is injected so the "advertised but broken" case is unit-testable.
 *
 * @returns {{encoder: string, rejected: string[]}}
 */
export function selectEncoder({ available, platform = process.platform, verify, crf = 16 }) {
  const candidates = candidateEncoders(available, platform);
  const rejected = [];

  for (const name of candidates) {
    if (verify(name, encodeArgs(name, { crf }))) return { encoder: name, rejected };
    rejected.push(name);
  }

  throw new Error(
    `No working H.264 encoder. Tried: ${candidates.length ? candidates.join(", ") : "(none advertised)"}. ` +
      `Install an ffmpeg build with libx264.`
  );
}

/**
 * Trial-encode one tiny synthetic frame. Exits non-zero if the encoder cannot open -
 * which is exactly what a compiled-in-but-unusable hardware encoder does.
 * Output goes to the null muxer, so nothing touches disk.
 */
export function verifyEncoder(encoder, args) {
  try {
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=0.1:size=64x64:rate=10",
        ...args,
        "-f", "null", "-",
      ],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 20_000 }
    );
    return true;
  } catch {
    return false;
  }
}

let cachedEncoders = null;
let cachedSelection = null;

/** Ask ffmpeg what it can do. Cached, ffmpeg's capabilities don't change mid-run. */
export function probeEncoders() {
  if (cachedEncoders) return cachedEncoders;
  try {
    const stdout = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    cachedEncoders = parseEncoders(stdout);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not run \`ffmpeg -encoders\`, is ffmpeg on PATH? (${why})`);
  }
  return cachedEncoders;
}

/**
 * The one call the pipeline needs: ffmpeg video args for a near-lossless intermediate.
 * Verified against the actual machine, and cached for the life of the process.
 *
 * @returns {{encoder: string, args: string[], rejected: string[]}}
 */
export function intermediateVideoArgs({ crf = 16, platform = process.platform } = {}) {
  if (cachedSelection && cachedSelection.crf === crf) return cachedSelection.result;

  const { encoder, rejected } = selectEncoder({
    available: probeEncoders(),
    platform,
    verify: verifyEncoder,
    crf,
  });

  const result = { encoder, args: encodeArgs(encoder, { crf }), rejected };
  cachedSelection = { crf, result };
  return result;
}

/** Test seam: drop cached probe + selection results. */
export function resetEncoderCache() {
  cachedEncoders = null;
  cachedSelection = null;
}
