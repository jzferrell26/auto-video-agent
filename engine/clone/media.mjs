// Local media steps for the clone module. FFmpeg and ffprobe always run with argument arrays,
// never through a shell. Outputs are created with -n (never overwrite).
import { spawnSync } from "node:child_process";
import { copyFileSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aacCheckArgs, estimateLag, int16ToFloat, loudnessVerdict, makeupGainDb, masterArgs, masterFilter,
  masterOptions, measureArgs, parseLoudnessSummary, pcmArgs, preGainFilter, remuxArgs, syncVerdict,
} from "./audio.mjs";
import { landscapePrepArgs, landscapePrepPlan } from "./framing.mjs";

export function runTool(tool, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(tool, args, { maxBuffer, windowsHide: true });
  if (result.error) {
    throw new Error(result.error.code === "ENOENT" ? tool + " is not installed or not on PATH. See docs/getting-started.md." : tool + " could not run to completion.");
  }
  const stderr = result.stderr ? result.stderr.toString("utf8") : "";
  if (result.status !== 0) {
    const lastLine = stderr.trim().split(/\r?\n/).pop() || "";
    throw new Error(tool + " failed (exit " + result.status + ")" + (lastLine ? ": " + lastLine.slice(0, 300) : "."));
  }
  return { stdout: result.stdout, stderr };
}

export function hasTool(tool) {
  const result = spawnSync(tool, ["-version"], { windowsHide: true });
  return !result.error && result.status === 0;
}

export function probeMedia(path) {
  const { stdout } = runTool("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", path]);
  let data;
  try { data = JSON.parse(stdout.toString("utf8")); } catch { throw new Error("ffprobe returned unreadable data."); }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const durationSec = Number(data.format && data.format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Could not read the media duration.");
  return {
    durationSec,
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    hasVideo: Boolean(video),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

export function measureLoudness(input, filterPrefix = "") {
  return parseLoudnessSummary(runTool("ffmpeg", measureArgs(input, filterPrefix)).stderr);
}

/**
 * High-pass, gate or compressor, makeup gain, limiter; then an AAC encode is measured with
 * ebur128 (true peak on). Writes the mastered WAV and the AAC check file only if both pass.
 */
export function masterVoice({ input, wavOut, checkOut, overrides = {}, makeupDb }) {
  const options = masterOptions(overrides);
  for (const path of [wavOut, checkOut]) if (existsSync(path)) throw new Error("Output already exists. Choose a new slug or inspect the previous run.");
  const work = mkdtempSync(join(tmpdir(), "clone-master-"));
  try {
    const before = measureLoudness(input);
    const preGain = measureLoudness(input, preGainFilter(options));
    let gain = makeupDb ?? makeupGainDb(preGain.integratedLufs, options.targetLufs);
    let measured;
    let wav;
    let check;
    for (let pass = 1; pass <= 2; pass += 1) {
      wav = join(work, "master-" + pass + ".wav");
      check = join(work, "check-" + pass + ".m4a");
      runTool("ffmpeg", masterArgs(input, wav, masterFilter(options, gain), options.sampleRate));
      runTool("ffmpeg", aacCheckArgs(wav, check, options.checkBitrate));
      measured = measureLoudness(check);
      const offBy = options.targetLufs - measured.integratedLufs;
      if (makeupDb !== undefined || Math.abs(offBy) <= 0.5 || pass === 2) break;
      gain = Number((gain + offBy).toFixed(2));
    }
    const verdict = loudnessVerdict(measured, options);
    if (!verdict.pass) throw new Error("Mastering did not meet the targets: " + verdict.problems.join("; ") + ". Nothing was written.");
    copyFileSync(wav, wavOut, constants.COPYFILE_EXCL);
    copyFileSync(check, checkOut, constants.COPYFILE_EXCL);
    return {
      input: { integratedLufs: before.integratedLufs, truePeakDb: before.truePeakDb },
      makeupDb: gain,
      filter: masterFilter(options, gain),
      afterAac: measured,
      targets: { integratedLufs: options.targetLufs, toleranceLu: options.lufsTolerance, maxTruePeakDb: options.maxTruePeakDb },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function readPcm(input, sampleRate, maxSeconds) {
  const bytes = Math.ceil(sampleRate * 2 * maxSeconds) + 1024 * 1024;
  return int16ToFloat(runTool("ffmpeg", pcmArgs(input, sampleRate, maxSeconds), { maxBuffer: bytes }).stdout);
}

/**
 * Compares the provider render's audio with the mastered voice. Only when the lag is within
 * tolerance does it write the final clip: the render's picture plus the mastered voice, capped
 * to the video's length. With faceX, a 16:9 render is reframed to 9:16 first.
 */
export function checkSyncAndMux({ render, master, output, faceX, maxLagMs = 0, minScore = 0.5, sampleRate = 16000, analysisSeconds = 120 }) {
  if (existsSync(output)) throw new Error("Output already exists. Choose a new slug or inspect the previous run.");
  const video = probeMedia(render);
  if (!video.hasVideo) throw new Error("The render has no video stream.");
  if (!video.hasAudio) throw new Error("The render has no audio track to compare with the mastered voice.");
  const seconds = Math.min(analysisSeconds, video.durationSec);
  const lag = estimateLag(readPcm(render, sampleRate, seconds), readPcm(master, sampleRate, seconds), { sampleRate });
  const verdict = syncVerdict(lag, { maxLagMs, minScore });
  if (!verdict.pass) throw new Error("Sync check failed: " + verdict.problems.join("; ") + ". Nothing was written.");
  let mode = "copy";
  let plan = null;
  if (faceX !== undefined) {
    plan = landscapePrepPlan({ sourceWidth: video.width, sourceHeight: video.height, faceX });
    runTool("ffmpeg", landscapePrepArgs(render, master, output, plan, video.durationSec));
    mode = "landscape-prep";
  } else {
    runTool("ffmpeg", remuxArgs(render, master, output, video.durationSec));
  }
  const result = probeMedia(output);
  return {
    lag, tolerance: { maxLagMs, minScore }, mode, plan,
    render: { width: video.width, height: video.height, durationSec: video.durationSec },
    output: { width: result.width, height: result.height, durationSec: result.durationSec },
  };
}
