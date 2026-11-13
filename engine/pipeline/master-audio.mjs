// Voice-safe loudness master for a rendered MP4. Video is copied untouched; only the audio is
// rebuilt, so a loudness fix never costs a second video encode.
//
// What it does, in order:
//   1. Trims the AAC encoder delay (priming, 2048 samples) that a Remotion render leaves at the
//      start of the audio, so the voice lines up with the picture.
//   2. Optional music bed (--bed): looped and trimmed to the voice length, resampled to 48 kHz
//      stereo, loudness-normalized to about -28 LUFS with a tight loudness range, given dips in
//      the speech band (near 1 kHz and 2.5 kHz), faded in and out, and sidechain-compressed under
//      the voice. The bed is mixed in without amix normalization, so levels stay as designed.
//      You must have the right to use the bed; this tool does not check that.
//   3. Two-pass loudnorm of the whole mix (measure, then a linear pass) to -14 LUFS integrated,
//      -1.5 dBTP, LRA 11. Encodes AAC 256k, copies the video, adds faststart.
//   4. Measures the result with ebur128 (true peak on). Only when the true peak is above
//      -1.0 dBTP does it re-encode through a brick-wall limiter and measure again.
//   5. Prints integrated LUFS and true peak.
//
// Usage:
//   npm run master:audio -- --video out/short.mp4 [--bed _sources/bed.wav] [--out out/short.mastered.mp4]
//
// The default output is <video>.mastered.mp4 next to the input. Paths must be inside this
// repository and the output must not exist. ffmpeg and ffprobe must be on PATH (ffmpeg 7.1 or
// newer, for amix normalize=0). All work files are written to a scratch folder and removed.
//
// Every command is built as an argument array; the builders are pure and unit-tested.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assertInsideRoot, main, outputDirectory } from "./runtime.mjs";

/** Remotion's AAC encoder delay, in samples at the stream's own rate. */
export const PRIMING_SAMPLES = 2048;

export const TARGETS = {
  lufs: -14,
  truePeak: -1.5,
  lra: 11,
  bedLufs: -28,
  bedLra: 2,
  /** Re-encode through the limiter only when the measured true peak is above this. */
  ceilingDbtp: -1.0,
  /** alimiter limit is linear amplitude: 0.79 is about -2.1 dBFS. */
  limiter: { limit: 0.79, attack: 1, release: 60 },
  bitrate: "256k",
  sampleRate: 48000,
};

const fixed = (n) => String(Math.round(n * 1000) / 1000);

/**
 * The filter graph that turns the render's audio (and an optional bed) into one stereo 48 kHz
 * mix labelled [mix].
 *
 * @param {{ hasBed: boolean, durationSec: number }} options durationSec is the voice length after the trim
 * @returns {string}
 */
export function buildMixGraph({ hasBed, durationSec }) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("durationSec must be a positive number.");
  const rate = TARGETS.sampleRate;
  const voice = `[0:a:0]atrim=start_sample=${PRIMING_SAMPLES},asetpts=PTS-STARTPTS,aresample=${rate},aformat=channel_layouts=stereo`;
  if (!hasBed) return `${voice}[mix]`;
  const fadeIn = Math.min(1.5, durationSec / 3);
  const fadeOut = Math.min(2.5, durationSec / 3);
  const fadeOutStart = Math.max(0, durationSec - fadeOut);
  const bed = [
    `[1:a:0]aresample=${rate}`,
    "aformat=channel_layouts=stereo",
    `atrim=duration=${fixed(durationSec)}`,
    "asetpts=PTS-STARTPTS",
    `loudnorm=I=${TARGETS.bedLufs}:LRA=${TARGETS.bedLra}:TP=-3`,
    `aresample=${rate}`, // loudnorm leaves its output at a high internal rate
    "equalizer=f=1000:t=q:w=1:g=-4",
    "equalizer=f=2500:t=q:w=1.2:g=-3",
    `afade=t=in:st=0:d=${fixed(fadeIn)}`,
    `afade=t=out:st=${fixed(fadeOutStart)}:d=${fixed(fadeOut)}[bed]`,
  ].join(",");
  return [
    `${voice},asplit=2[vkey][vmix]`,
    bed,
    "[bed][vkey]sidechaincompress=threshold=0.04:ratio=8:attack=15:release=350[ducked]",
    "[vmix][ducked]amix=inputs=2:duration=first:normalize=0[mix]",
  ].join(";");
}

/** Argument array that renders the mix to a float WAV (the only lossy-free hop). */
export function buildMixArgs({ video, bed, wavOut, durationSec }) {
  return [
    "-nostdin", "-hide_banner", "-n",
    "-i", video,
    ...(bed ? ["-stream_loop", "-1", "-i", bed] : []),
    "-filter_complex", buildMixGraph({ hasBed: Boolean(bed), durationSec }),
    "-map", "[mix]", "-c:a", "pcm_f32le", "-ar", String(TARGETS.sampleRate), "-ac", "2",
    wavOut,
  ];
}

const loudnormTarget = `I=${TARGETS.lufs}:TP=${TARGETS.truePeak}:LRA=${TARGETS.lra}`;

/** First loudnorm pass: measure only, JSON on stderr. */
export function buildMeasureArgs(wav) {
  return ["-nostdin", "-hide_banner", "-i", wav, "-af", `loudnorm=${loudnormTarget}:print_format=json`, "-f", "null", "-"];
}

/**
 * The second, linear loudnorm pass, encoded as AAC next to the untouched video.
 *
 * @param {{ video: string, wav: string, out: string, measured: Measured, limiter?: boolean }} input
 */
export function buildEncodeArgs({ video, wav, out, measured, limiter = false }) {
  const linear = `loudnorm=${loudnormTarget}` +
    `:measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:measured_TP=${measured.input_tp}` +
    `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`;
  const { limit, attack, release } = TARGETS.limiter;
  const chain = [linear, `aresample=${TARGETS.sampleRate}`];
  if (limiter) chain.push(`alimiter=limit=${limit}:attack=${attack}:release=${release}:level=disabled`);
  return [
    "-nostdin", "-hide_banner", "-n",
    "-i", video, "-i", wav,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-af", chain.join(","),
    "-c:a", "aac", "-b:a", TARGETS.bitrate, "-ar", String(TARGETS.sampleRate), "-ac", "2",
    "-movflags", "+faststart",
    out,
  ];
}

/** Integrated loudness and true peak of a file's audio. */
export function buildEbur128Args(file) {
  return ["-nostdin", "-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"];
}

export function buildProbeArgs(file) {
  return ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,duration:format=duration", "-of", "json", file];
}

const finiteString = (what) =>
  z.string().transform((value, ctx) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: what + " is not a finite number (" + value + "); the audio may be silent." });
      return z.NEVER;
    }
    return value;
  });

const loudnormSchema = z.object({
  input_i: finiteString("input_i"),
  input_tp: finiteString("input_tp"),
  input_lra: finiteString("input_lra"),
  input_thresh: finiteString("input_thresh"),
  target_offset: finiteString("target_offset"),
});

/** @typedef {z.infer<typeof loudnormSchema>} Measured */

/** Pull the loudnorm JSON block out of ffmpeg's stderr and validate it. */
export function parseLoudnormJson(stderr) {
  const blocks = String(stderr).match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks) throw new Error("Could not find loudnorm measurements in ffmpeg output.");
  return loudnormSchema.parse(JSON.parse(blocks[blocks.length - 1]));
}

/**
 * Read the final Summary of ebur128: integrated loudness (LUFS) and true peak (dBTP).
 *
 * @returns {{ lufs: number, truePeak: number }}
 */
export function parseEbur128(stderr) {
  const text = String(stderr);
  const summary = text.slice(text.lastIndexOf("Summary:"));
  const lufs = /\bI:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
  const peak = /True peak:[\s\S]*?Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
  if (!lufs || !peak) throw new Error("Could not read the ebur128 summary from ffmpeg output.");
  const result = { lufs: Number(lufs[1]), truePeak: Number(peak[1]) };
  if (!Number.isFinite(result.lufs) || !Number.isFinite(result.truePeak)) throw new Error("The mastered audio is silent or unmeasurable.");
  return result;
}

/** True when the measured peak is over the ceiling and the limiter pass is needed. */
export const needsLimiter = (truePeak) => truePeak > TARGETS.ceilingDbtp;

const probeSchema = z.object({
  streams: z.array(z.object({ sample_rate: z.string().optional(), duration: z.string().optional() })),
  format: z.object({ duration: z.string().optional() }),
});

/** Read the voice length after the priming trim. Throws when the video has no audio. */
export function voiceDuration(probeJson) {
  const probe = probeSchema.parse(JSON.parse(probeJson));
  const stream = probe.streams[0];
  if (!stream) throw new Error("The video has no audio stream to master.");
  const rate = Number(stream.sample_rate);
  const total = Number(stream.duration ?? probe.format.duration);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(total) || total <= 0) throw new Error("Could not read the audio duration.");
  const seconds = total - PRIMING_SAMPLES / rate;
  if (seconds <= 0.5) throw new Error("The audio is too short to master.");
  return seconds;
}

/** Run a tool with an argument array and return its stderr text. Throws with the tail on failure. */
export function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw new Error(result.error.code === "ENOENT" ? command + " is not installed or not on PATH." : result.error.message);
  }
  if (result.status !== 0) throw new Error(command + " failed:\n" + String(result.stderr).split("\n").slice(-12).join("\n"));
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * Master one rendered file. `exec` runs a tool and returns { stdout, stderr }; it is injectable
 * so the control flow can be tested without ffmpeg.
 *
 * @param {{ video: string, bed?: string, out: string, scratch: string, exec?: typeof runTool, log?: (line: string) => void }} input
 * @returns {{ out: string, lufs: number, truePeak: number, limited: boolean }}
 */
export function masterAudio({ video, bed, out, scratch, exec = runTool, log = () => {} }) {
  if (existsSync(out)) throw new Error("Output already exists. Choose a new name or inspect the previous run.");
  const durationSec = voiceDuration(exec("ffprobe", buildProbeArgs(video)).stdout);

  const wav = join(scratch, "mix.wav");
  log("mixing audio" + (bed ? " with a music bed" : ""));
  exec("ffmpeg", buildMixArgs({ video, bed, wavOut: wav, durationSec }));

  log("measuring loudness (pass 1)");
  const measured = parseLoudnormJson(exec("ffmpeg", buildMeasureArgs(wav)).stderr);

  let pass = join(scratch, "pass-1.mp4");
  log("normalizing to " + TARGETS.lufs + " LUFS (pass 2)");
  exec("ffmpeg", buildEncodeArgs({ video, wav, out: pass, measured }));
  let result = parseEbur128(exec("ffmpeg", buildEbur128Args(pass)).stderr);

  let limited = false;
  if (needsLimiter(result.truePeak)) {
    log("true peak " + result.truePeak + " dBTP is above " + TARGETS.ceilingDbtp + "; applying the limiter");
    const limitedPass = join(scratch, "pass-2.mp4");
    exec("ffmpeg", buildEncodeArgs({ video, wav, out: limitedPass, measured, limiter: true }));
    result = parseEbur128(exec("ffmpeg", buildEbur128Args(limitedPass)).stderr);
    pass = limitedPass;
    limited = true;
  }

  // Check again right before moving, so a file created meanwhile is never replaced.
  if (existsSync(out)) throw new Error("Output already exists. Choose a new name or inspect the previous run.");
  renameSync(pass, out);
  return { out, lufs: result.lufs, truePeak: result.truePeak, limited };
}

/** Parse `--name value` pairs. Unknown flags are refused. */
export function parseMasterArgs(argv) {
  const values = new Set(["video", "bed", "out"]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--") || !values.has(flag.slice(2))) throw new Error("Unknown argument " + flag + ". Usage: npm run master:audio -- --video <mp4> [--bed <audio>] [--out <mp4>]");
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(flag + " needs a value");
    out[flag.slice(2)] = value;
  }
  return out;
}

export function masterCommand(argv) {
  const args = parseMasterArgs(argv);
  if (!args.video) throw new Error("--video is required. Usage: npm run master:audio -- --video <mp4> [--bed <audio>] [--out <mp4>]");
  const video = assertInsideRoot(args.video, "--video");
  const bed = args.bed ? assertInsideRoot(args.bed, "--bed") : undefined;
  const out = assertInsideRoot(args.out ?? args.video.replace(/\.mp4$/i, "") + ".mastered.mp4", "--out");
  if (existsSync(out)) throw new Error("Output already exists. Choose a new name or inspect the previous run.");
  const scratch = mkdtempSync(join(outputDirectory("out"), "master-"));
  try {
    const result = masterAudio({ video, bed, out, scratch, log: (line) => console.log(line) });
    console.log("Mastered: " + result.out);
    console.log("Integrated loudness: " + result.lufs + " LUFS (target " + TARGETS.lufs + ")");
    console.log("True peak: " + result.truePeak + " dBTP (ceiling " + TARGETS.ceilingDbtp + ")" + (result.limited ? ", limiter applied" : ""));
    console.log("Listen to the result before publishing; the numbers do not judge the mix.");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main(import.meta.url, masterCommand);
