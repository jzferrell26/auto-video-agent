// Locks encoder selection and quality profiles.
// Pure functions and an injected verifier, never shells out, so it runs anywhere.
import { test } from "vitest";
import assert from "node:assert/strict";
import { candidateEncoders, encodeArgs, parseEncoders, selectEncoder } from "../engine/pipeline/encoder.mjs";

// Realistic `ffmpeg -encoders` output, legend included. Note it advertises nvenc/qsv/
// vaapi, a stock Linux build does this whether or not the hardware is present.
const FFMPEG_OUTPUT = `
Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx264rgb           libx264 H.264 RGB (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration) (codec h264)
 V..... h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 A..... aac                  AAC (Advanced Audio Coding)
 V..... libx265              libx265 H.265 / HEVC (codec hevc)
`;

const acceptAll = () => true;
const acceptOnly = (...names) => (name) => names.includes(name);

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test("parses encoder names and ignores the legend", () => {
  const names = parseEncoders(FFMPEG_OUTPUT);
  assert.ok(names.has("libx264"));
  assert.ok(names.has("h264_nvenc"));
  assert.ok(names.has("h264_vaapi"));
  assert.ok(names.has("aac"));
  // The legend rows (" V..... = Video") must not become an encoder named "=".
  assert.ok(!names.has("="));
  assert.ok(!names.has("Video"));
});

test("parses empty output without throwing", () => {
  assert.equal(parseEncoders("").size, 0);
});

// ---------------------------------------------------------------------------
// candidate ordering
// ---------------------------------------------------------------------------

test("orders candidates hardware-first, libx264 last", () => {
  assert.deepEqual(candidateEncoders(parseEncoders(FFMPEG_OUTPUT), "linux"), [
    "h264_nvenc",
    "h264_qsv",
    "h264_vaapi",
    "libx264",
  ]);
});

test("filters out encoders ffmpeg does not advertise", () => {
  assert.deepEqual(candidateEncoders(["libx264"], "linux"), ["libx264"]);
});

test("ignores a hardware encoder from another platform", () => {
  // videotoolbox advertised on Linux is not in Linux's preference list.
  assert.deepEqual(candidateEncoders(["libx264", "h264_videotoolbox"], "linux"), ["libx264"]);
});

test("uses the libx264-only list for an unknown platform", () => {
  assert.deepEqual(candidateEncoders(["libx264", "h264_nvenc"], "sunos"), ["libx264"]);
});

// ---------------------------------------------------------------------------
// selection: the advertised-but-broken case is the whole point
// ---------------------------------------------------------------------------

test("picks the first hardware encoder when it verifies", () => {
  const { encoder, rejected } = selectEncoder({
    available: parseEncoders(FFMPEG_OUTPUT),
    platform: "linux",
    verify: acceptAll,
  });
  assert.equal(encoder, "h264_nvenc");
  assert.deepEqual(rejected, []);
});

test("falls back past an ADVERTISED BUT BROKEN hardware encoder", () => {
  // This is the real-world case: `ffmpeg -encoders` lists h264_nvenc on a box with no
  // NVIDIA driver, and it fails at encoder-open with "Cannot load libcuda.so.1".
  // Trusting the advertised list here would break every clip encode.
  const { encoder, rejected } = selectEncoder({
    available: parseEncoders(FFMPEG_OUTPUT),
    platform: "linux",
    verify: acceptOnly("libx264"),
  });
  assert.equal(encoder, "libx264");
  assert.deepEqual(rejected, ["h264_nvenc", "h264_qsv", "h264_vaapi"]);
});

test("stops at the first encoder that verifies, without trying the rest", () => {
  const tried = [];
  const { encoder } = selectEncoder({
    available: parseEncoders(FFMPEG_OUTPUT),
    platform: "linux",
    verify: (name) => {
      tried.push(name);
      return name === "h264_qsv";
    },
  });
  assert.equal(encoder, "h264_qsv");
  assert.deepEqual(tried, ["h264_nvenc", "h264_qsv"], "must not verify past the winner");
});

test("verify receives the same args that will be used to encode", () => {
  const seen = {};
  selectEncoder({
    available: ["libx264"],
    platform: "linux",
    verify: (name, args) => {
      seen[name] = args;
      return true;
    },
    crf: 12,
  });
  assert.deepEqual(seen.libx264, encodeArgs("libx264", { crf: 12 }));
});

test("throws with the attempted list when nothing verifies", () => {
  assert.throws(
    () =>
      selectEncoder({
        available: parseEncoders(FFMPEG_OUTPUT),
        platform: "linux",
        verify: () => false,
      }),
    /** @param {Error} err */
    (err) => {
      assert.match(err.message, /No working H\.264 encoder/);
      assert.match(err.message, /h264_nvenc, h264_qsv, h264_vaapi, libx264/);
      return true;
    }
  );
});

test("throws when ffmpeg advertises no usable candidate at all", () => {
  assert.throws(
    () => selectEncoder({ available: ["aac"], platform: "linux", verify: acceptAll }),
    /** @param {Error} err */
    (err) => {
      assert.match(err.message, /none advertised/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// quality profiles
// ---------------------------------------------------------------------------

test("libx264 profile targets near-lossless, not the CRF 23 default", () => {
  const args = encodeArgs("libx264");
  const crf = Number(args[args.indexOf("-crf") + 1]);
  assert.ok(crf <= 18, `expected a near-lossless CRF for the intermediate, got ${crf}`);
  assert.deepEqual(args.slice(0, 2), ["-c:v", "libx264"]);
});

test("crf is overridable and lands in the emitted args", () => {
  const args = encodeArgs("libx264", { crf: 12 });
  assert.equal(args[args.indexOf("-crf") + 1], "12");
});

test("videotoolbox uses constant quality, never -crf", () => {
  const args = encodeArgs("h264_videotoolbox");
  assert.ok(!args.includes("-crf"), "-crf is silently ignored by videotoolbox");
  assert.ok(args.includes("-q:v"));
  // -b:v 0 is load-bearing: without it -q:v does nothing.
  assert.equal(args[args.indexOf("-b:v") + 1], "0");
});

test("nvenc uses -cq rather than -crf", () => {
  const args = encodeArgs("h264_nvenc");
  assert.ok(!args.includes("-crf"));
  assert.ok(args.includes("-cq"));
});

test("vaapi includes the hwupload filter it requires", () => {
  assert.match(encodeArgs("h264_vaapi")[encodeArgs("h264_vaapi").indexOf("-vf") + 1], /hwupload/);
});

test("every candidate encoder across all platforms has a quality profile", () => {
  /** @type {NodeJS.Platform[]} */
  const platforms = ["darwin", "linux", "win32"];
  const all = new Set(
    platforms.flatMap((p) =>
      candidateEncoders(
        ["h264_videotoolbox", "h264_nvenc", "h264_qsv", "h264_vaapi", "h264_amf", "libx264"],
        p
      )
    )
  );
  for (const enc of all) {
    assert.ok(encodeArgs(enc).length > 0, `${enc} has no profile`);
  }
  assert.ok(all.size >= 6, `expected every platform's candidates covered, saw ${all.size}`);
});

test("an unknown encoder throws rather than emitting bare flags", () => {
  assert.throws(() => encodeArgs("h264_imaginary"), /no quality profile/);
});
