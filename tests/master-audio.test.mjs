// Locks the audio master: argument arrays, filter graph, parsers and the limiter decision.
// The control-flow tests inject a fake tool runner, so no ffmpeg or media is needed.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  PRIMING_SAMPLES, TARGETS, buildEbur128Args, buildEncodeArgs, buildMeasureArgs, buildMixArgs, buildMixGraph,
  masterAudio, needsLimiter, parseEbur128, parseLoudnormJson, parseMasterArgs, voiceDuration,
} from "../engine/pipeline/master-audio.mjs";

const LOUDNORM_STDERR = [
  "[Parsed_loudnorm_0 @ 0000] ",
  "{",
  '\t"input_i" : "-21.40",',
  '\t"input_tp" : "-6.12",',
  '\t"input_lra" : "3.10",',
  '\t"input_thresh" : "-31.90",',
  '\t"output_i" : "-14.20",',
  '\t"output_tp" : "-1.50",',
  '\t"output_lra" : "2.80",',
  '\t"output_thresh" : "-24.70",',
  '\t"normalization_type" : "dynamic",',
  '\t"target_offset" : "0.20"',
  "}",
  "",
].join("\n");
const ebur = (lufs, peak) => [
  "junk",
  "[Parsed_ebur128_0 @ 0000] Summary:",
  "",
  "  Integrated loudness:",
  "    I:         " + lufs + " LUFS",
  "    Threshold: -24.5 LUFS",
  "",
  "  Loudness range:",
  "    LRA:         3.1 LU",
  "",
  "  True peak:",
  "    Peak:       " + peak + " dBFS",
  "",
].join("\n");
const probe = JSON.stringify({ streams: [{ sample_rate: "48000", duration: "10.000000" }], format: { duration: "10.04" } });
const measured = parseLoudnormJson(LOUDNORM_STDERR);

describe("filter graph", () => {
  test("voice only: trims the AAC priming, resamples to 48 kHz stereo, no bed filters", () => {
    const graph = buildMixGraph({ hasBed: false, durationSec: 10 });
    expect(graph).toContain("atrim=start_sample=" + PRIMING_SAMPLES);
    expect(PRIMING_SAMPLES).toBe(2048);
    expect(graph).toContain("aresample=48000");
    expect(graph).toContain("channel_layouts=stereo");
    expect(graph.endsWith("[mix]")).toBe(true);
    expect(graph).not.toContain("sidechaincompress");
  });
  test("with a bed: normalizes to -28 LUFS, carves 1 kHz and 2.5 kHz, fades, ducks, mixes unnormalized", () => {
    const graph = buildMixGraph({ hasBed: true, durationSec: 12.5 });
    expect(graph).toContain("loudnorm=I=-28:LRA=2");
    expect(graph).toContain("equalizer=f=1000");
    expect(graph).toContain("equalizer=f=2500");
    expect(graph).toContain("afade=t=in:st=0:d=1.5");
    expect(graph).toContain("afade=t=out:st=10:d=2.5");
    expect(graph).toContain("atrim=duration=12.5");
    expect(graph).toContain("[bed][vkey]sidechaincompress=");
    expect(graph).toContain("amix=inputs=2:duration=first:normalize=0");
    expect(graph.endsWith("[mix]")).toBe(true);
  });
  test("very short audio shortens the fades instead of producing negative times", () => {
    const graph = buildMixGraph({ hasBed: true, durationSec: 3 });
    expect(graph).toContain("afade=t=in:st=0:d=1");
    expect(graph).toContain("afade=t=out:st=2:d=1");
  });
  test.each([0, -1, Number.NaN])("rejects a bad duration %s", (durationSec) => {
    expect(() => buildMixGraph({ hasBed: false, durationSec })).toThrow("positive");
  });
});

describe("argument arrays", () => {
  test("mix args loop the bed, never overwrite, and write a float WAV", () => {
    const args = buildMixArgs({ video: "v.mp4", bed: "bed.wav", wavOut: "mix.wav", durationSec: 10 });
    const at = args.indexOf("-stream_loop");
    expect(args.slice(at, at + 4)).toEqual(["-stream_loop", "-1", "-i", "bed.wav"]);
    expect(args).toContain("-n");
    expect(args).toContain("pcm_f32le");
    expect(args.at(-1)).toBe("mix.wav");
    expect(buildMixArgs({ video: "v.mp4", wavOut: "m.wav", durationSec: 5 })).not.toContain("-stream_loop");
  });
  test("pass 1 measures to the -14 / -1.5 / 11 targets", () => {
    const args = buildMeasureArgs("mix.wav");
    expect(args[args.indexOf("-af") + 1]).toBe("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json");
  });
  test("pass 2 is linear, uses the measurements, copies video, encodes AAC 256k with faststart", () => {
    const args = buildEncodeArgs({ video: "v.mp4", wav: "mix.wav", out: "o.mp4", measured });
    const filter = args[args.indexOf("-af") + 1];
    for (const part of ["I=-14", "TP=-1.5", "LRA=11", "measured_I=-21.40", "measured_TP=-6.12", "measured_LRA=3.10", "measured_thresh=-31.90", "offset=0.20", "linear=true"]) {
      expect(filter).toContain(part);
    }
    expect(filter).not.toContain("alimiter");
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args[args.indexOf("-b:a") + 1]).toBe("256k");
    expect(args).toContain("+faststart");
    expect(args).toContain("-n");
    expect(args.at(-1)).toBe("o.mp4");
  });
  test("the limiter variant adds alimiter with the specified settings and nothing else changes", () => {
    const plain = buildEncodeArgs({ video: "v", wav: "w", out: "o", measured });
    const limited = buildEncodeArgs({ video: "v", wav: "w", out: "o", measured, limiter: true });
    const filter = limited[limited.indexOf("-af") + 1];
    expect(filter).toContain("alimiter=limit=0.79:attack=1:release=60:level=disabled");
    expect(filter.startsWith(plain[plain.indexOf("-af") + 1])).toBe(true);
  });
  test("ebur128 runs with true peak on and a quiet frame log", () => {
    expect(buildEbur128Args("f.mp4").join(" ")).toContain("ebur128=peak=true:framelog=quiet");
  });
});

describe("parsers", () => {
  test("reads the loudnorm JSON from noisy stderr", () => {
    expect(measured.input_i).toBe("-21.40");
    expect(measured.target_offset).toBe("0.20");
  });
  test("rejects missing or non-finite measurements (silent audio)", () => {
    expect(() => parseLoudnormJson("nothing here")).toThrow("Could not find");
    expect(() => parseLoudnormJson(LOUDNORM_STDERR.replace('"-21.40"', '"-inf"'))).toThrow();
  });
  test("reads integrated loudness and true peak from the last summary", () => {
    expect(parseEbur128(ebur("-14.1", "-1.8"))).toEqual({ lufs: -14.1, truePeak: -1.8 });
    expect(() => parseEbur128("no summary")).toThrow("Could not read");
    expect(() => parseEbur128(ebur("-inf", "-inf"))).toThrow("silent");
  });
  test("the limiter runs only above -1.0 dBTP", () => {
    expect(TARGETS.ceilingDbtp).toBe(-1.0);
    expect(needsLimiter(-1.0)).toBe(false);
    expect(needsLimiter(-1.5)).toBe(false);
    expect(needsLimiter(-0.9)).toBe(true);
  });
  test("voice length is the audio length minus the priming", () => {
    expect(voiceDuration(probe)).toBeCloseTo(10 - 2048 / 48000, 6);
    expect(() => voiceDuration(JSON.stringify({ streams: [], format: {} }))).toThrow("no audio");
  });
  test("argument parsing refuses unknown flags and missing values", () => {
    expect(parseMasterArgs(["--video", "a.mp4", "--bed", "b.wav"])).toEqual({ video: "a.mp4", bed: "b.wav" });
    expect(() => parseMasterArgs(["--vidoe", "a.mp4"])).toThrow("Unknown argument");
    expect(() => parseMasterArgs(["--video"])).toThrow("needs a value");
  });
});

describe("control flow with a fake runner", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "master-test-"));
    return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
  };
  /** A runner that records calls and writes a placeholder wherever ffmpeg would write a file. */
  const fake = (peaks) => {
    const calls = [];
    let measuredCount = 0;
    const exec = (command, args) => {
      calls.push({ command, args });
      if (command === "ffprobe") return { stdout: probe, stderr: "" };
      if (args.some((a) => String(a).includes("print_format=json"))) return { stdout: "", stderr: LOUDNORM_STDERR };
      if (args.some((a) => String(a).includes("ebur128"))) return { stdout: "", stderr: ebur("-14.0", peaks[measuredCount++]) };
      writeFileSync(args.at(-1), "x"); // an encode: create its output file
      return { stdout: "", stderr: "" };
    };
    return { exec, calls };
  };

  test("a peak at or under -1.0 dBTP is delivered after one encode, with no limiter", () => {
    const t = setup();
    const { exec, calls } = fake(["-1.4"]);
    const out = join(t.dir, "final.mp4");
    const result = masterAudio({ video: "v.mp4", out, scratch: t.dir, exec });
    expect(result).toEqual({ out, lufs: -14, truePeak: -1.4, limited: false });
    expect(existsSync(out)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("alimiter");
    t.done();
  });
  test("a hot peak triggers one limiter pass and a re-measure of that pass", () => {
    const t = setup();
    const { exec, calls } = fake(["-0.4", "-1.6"]);
    const out = join(t.dir, "final.mp4");
    const result = masterAudio({ video: "v.mp4", bed: "bed.wav", out, scratch: t.dir, exec });
    expect(result.limited).toBe(true);
    expect(result.truePeak).toBe(-1.6);
    expect(calls.filter((c) => JSON.stringify(c.args).includes("alimiter"))).toHaveLength(1);
    expect(calls.filter((c) => JSON.stringify(c.args).includes("ebur128"))).toHaveLength(2);
    expect(JSON.stringify(calls)).toContain("sidechaincompress");
    t.done();
  });
  test("refuses to overwrite an existing output", () => {
    const t = setup();
    const out = join(t.dir, "final.mp4");
    writeFileSync(out, "keep me");
    expect(() => masterAudio({ video: "v.mp4", out, scratch: t.dir, exec: fake(["-2"]).exec })).toThrow("already exists");
    expect(readFileSync(out, "utf8")).toBe("keep me");
    t.done();
  });
});
