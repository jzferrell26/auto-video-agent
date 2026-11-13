// Clone-video module tests. Network calls are mocked; FFmpeg tests skip when FFmpeg is absent.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ROOT } from "../engine/pipeline/runtime.mjs";
import { evaluateConsent, loadConsent } from "../engine/clone/consent.mjs";
import { configSchema, jobSchema } from "../engine/clone/config.mjs";
import { createHeyGenClient, downloadToFile } from "../engine/clone/heygen.mjs";
import {
  estimateLag, fft, loudnessVerdict, makeupGainDb, masterFilter, masterOptions, parseLoudnessSummary,
  pcmArgs, preGainFilter, remuxArgs, syncVerdict,
} from "../engine/clone/audio.mjs";
import { SequenceMatcher, alignScriptToWords, mergeWhisperTokens } from "../engine/clone/captions.mjs";
import { landscapePrepArgs, landscapePrepFilter, landscapePrepPlan, publicMediaPath, validateClipCrop } from "../engine/clone/framing.mjs";
import { assignLooks } from "../engine/clone/looks.mjs";
import { buildSplicedShortProps, findPhrase, splicedShortPropsSchema } from "../engine/clone/props.mjs";
import { checkSyncAndMux, hasTool, masterVoice, probeMedia, runTool } from "../engine/clone/media.mjs";
import { runClone } from "../engine/clone/cli.mjs";
import { inspectFile } from "../scripts/check-hygiene.mjs";

const TODAY = "2026-11-12";
const example = (name) => JSON.parse(readFileSync(join(ROOT, "engine/examples", name), "utf8"));
const consentRecord = (changes = {}) => {
  const record = example("clone-consent.example.json");
  delete record.isExample;
  return { ...record, ...changes };
};
const testConfig = {
  schema: "clone-config/1",
  voice: { voiceId: "voice_test_0001", speed: 1.1 },
  looks: {
    "desk-a": { avatarId: "look_test_portrait", orientation: "portrait" },
    "desk-b": { avatarId: "look_test_landscape", orientation: "landscape", faceX: 0.4 },
    "desk-c": { avatarId: "look_test_third", orientation: "portrait" },
  },
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function mockFetch(responses) {
  const calls = [];
  const impl = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (!responses.length) throw new Error("Unexpected network call");
    return responses.shift();
  });
  return { impl, calls };
}
const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "clone-test-"));
  temps.push(dir);
  return dir;
}
function tempRoot({ consent = consentRecord(), config, job } = {}) {
  const root = tempDir();
  mkdirSync(join(root, "clone-private", "consent"), { recursive: true });
  writeFileSync(join(root, "clone-private/consent/record.json"), JSON.stringify(consent));
  if (config) writeFileSync(join(root, "clone-private/config.json"), JSON.stringify(config));
  if (job) {
    mkdirSync(join(root, "brand-props"), { recursive: true });
    writeFileSync(join(root, "brand-props/job.json"), JSON.stringify(job));
  }
  return root;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("consent gate", () => {
  const needs = ["voice", "likeness"];
  test("accepts a complete record that covers the requested use and platforms", () => {
    const record = evaluateConsent(consentRecord(), { needs, today: TODAY, use: "short-form", platforms: ["YouTube-Shorts"] });
    expect(record.id).toBe("consent-example-001");
  });
  test("refuses the unedited example template", () => {
    expect(() => evaluateConsent(example("clone-consent.example.json"), { needs, today: TODAY })).toThrow(/example consent template/);
  });
  test.each([
    ["expired", { expires: "2026-06-01" }, /expired on 2026-06-01/],
    ["revoked", { revocation: { contact: "in writing", revokedOn: "2026-10-01" } }, /revoked on 2026-10-01/],
    ["future-dated", { signedOn: "2027-01-01" }, /future/],
    ["voice only", { authorizes: { voice: true, likeness: false } }, /does not authorize the likeness/],
  ])("refuses a %s record", (_name, changes, message) => {
    expect(() => evaluateConsent(consentRecord(changes), { needs, today: TODAY })).toThrow(message);
  });
  test("refuses uses and platforms the person did not agree to", () => {
    expect(() => evaluateConsent(consentRecord(), { needs, today: TODAY, use: "paid ads" })).toThrow(/does not list the use|excludes the use/);
    expect(() => evaluateConsent(consentRecord({ scope: { uses: ["short-form", "paid ads"], excludedUses: ["paid ads"] } }), { needs, today: TODAY, use: "paid ads" })).toThrow(/excludes the use/);
    expect(() => evaluateConsent(consentRecord(), { needs, today: TODAY, platforms: ["facebook-reels"] })).toThrow(/platform "facebook-reels"/);
  });
  test.each([
    ["no AI-disclosure acknowledgement", { aiDisclosure: { acknowledged: false } }],
    ["no adult confirmation", { person: { name: "Avery Example", adultConfirmed: false } }],
    ["an impossible date", { signedOn: "2026-02-30" }],
    ["nothing authorized", { authorizes: { voice: false, likeness: false } }],
    ["no revocation contact", { revocation: { contact: "", revokedOn: null } }],
    ["an unknown field", { notes: "extra" }],
  ])("refuses a record with %s", (_name, changes) => {
    expect(() => evaluateConsent(consentRecord(changes), { needs, today: TODAY })).toThrow();
  });
  test("loads records only from inside the ignored clone-private folder", () => {
    const root = tempRoot();
    expect(loadConsent("clone-private/consent/record.json", { root }).id).toBe("consent-example-001");
    writeFileSync(join(root, "elsewhere.json"), JSON.stringify(consentRecord()));
    expect(() => loadConsent("elsewhere.json", { root })).toThrow(/inside the ignored clone-private/);
    expect(() => loadConsent("clone-private/../elsewhere.json", { root })).toThrow(/inside the ignored clone-private/);
    expect(() => loadConsent("clone-private/consent/missing.json", { root })).toThrow(/not found/);
    expect(() => loadConsent(undefined, { root })).toThrow(/--consent/);
  });
});

describe("private folder stays out of git", () => {
  test.each(["clone-private/consent/record.json", "clone-private/config.json", "clone-private/state.json"])("git ignores %s", (path) => {
    expect(() => execFileSync("git", ["check-ignore", "-q", path], { cwd: ROOT })).not.toThrow();
  });
  test("the hygiene check rejects files in clone-private", () => {
    expect(inspectFile("clone-private/consent/record.json", "{}")).toContain("generated/private directory");
    expect(inspectFile("nested/clone-private/config.json", "{}")).toContain("generated/private directory");
  });
  test("the hygiene check flags provider-id-shaped values but not commit pins", () => {
    expect(inspectFile("notes.md", "look " + "a1".repeat(16))).toContain("provider-id-shaped value");
    expect(inspectFile("ci.yml", "uses: actions/checkout@" + "b".repeat(40))).toEqual([]);
  });
  test("the example environment keeps HEYGEN_API_KEY empty", () => {
    expect(inspectFile(".env.example", readFileSync(join(ROOT, ".env.example"), "utf8"))).toEqual([]);
    expect(readFileSync(join(ROOT, ".env.example"), "utf8")).toMatch(/^HEYGEN_API_KEY=$/m);
  });
  test("the examples validate and contain placeholders, not ids", () => {
    expect(() => configSchema.parse(example("clone-config.example.json"))).not.toThrow();
    expect(() => jobSchema.parse(example("clone-job.example.json"))).not.toThrow();
    expect(JSON.stringify(example("clone-config.example.json"))).toContain("replace-with-");
  });
});

describe("HeyGen client (mocked network)", () => {
  const key = "test-key-not-real";
  const audioUrl = "https://files.example.test/speech.wav";
  test("needs a key and never starts without one", () => {
    expect(() => createHeyGenClient({ apiKey: "", fetchImpl: vi.fn() })).toThrow(/HEYGEN_API_KEY is not set/);
  });
  test("text to speech sends the chosen speed explicitly to the documented endpoint", async () => {
    const { impl, calls } = mockFetch([json(200, { data: { audio_url: audioUrl, duration: 3.2 } })]);
    const result = await createHeyGenClient({ apiKey: key, fetchImpl: impl }).generateSpeech({ voiceId: "voice_test_0001", text: "Hello there.", speed: 1.1, language: "en" });
    expect(result).toEqual({ audioUrl, durationSec: 3.2 });
    expect(calls[0].url).toBe("https://api.heygen.com/v3/models/audio/tts");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.headers["X-Api-Key"]).toBe(key);
    expect(JSON.parse(calls[0].init.body)).toEqual({ voice_id: "voice_test_0001", text: "Hello there.", model: "heygen-voice-1", speed: 1.1, language: "en" });
  });
  test.each([undefined, 0.5, 1.3])("refuses speed %s before any request", async (speed) => {
    const { impl } = mockFetch([]);
    await expect(createHeyGenClient({ apiKey: key, fetchImpl: impl }).generateSpeech({ voiceId: "voice_test_0001", text: "Hi", speed })).rejects.toThrow(/speed/);
    expect(impl).not.toHaveBeenCalled();
  });
  test("errors show the status and a known code, never the provider body", async () => {
    const { impl } = mockFetch([json(402, { error: { code: "insufficient_credit", message: "private provider text" } })]);
    const failure = createHeyGenClient({ apiKey: key, fetchImpl: impl }).generateSpeech({ voiceId: "voice_test_0001", text: "Hi", speed: 1 });
    await expect(failure).rejects.toThrow("HTTP 402, insufficient_credit");
    await expect(failure).rejects.not.toThrow(/private provider text|test-key/);
    const unknown = mockFetch([json(400, { error: { code: "echo_this_value" } })]);
    await expect(createHeyGenClient({ apiKey: key, fetchImpl: unknown.impl }).getVideo("video_1")).rejects.not.toThrow(/echo_this_value/);
  });
  test("malformed success cannot pass as a finished result", async () => {
    const { impl } = mockFetch([json(200, { data: { audio_url: "http://insecure.example.test/a.wav", duration: 1 } })]);
    await expect(createHeyGenClient({ apiKey: key, fetchImpl: impl }).generateSpeech({ voiceId: "voice_test_0001", text: "Hi", speed: 1 })).rejects.toThrow(/unexpected response/);
  });
  test("retries 429 after Retry-After and stops after three attempts on 503", async () => {
    const sleep = vi.fn(async () => {});
    const ok = mockFetch([json(429, {}, { "retry-after": "2" }), json(200, { data: { audio_url: audioUrl, duration: 1 } })]);
    await createHeyGenClient({ apiKey: key, fetchImpl: ok.impl, sleep }).generateSpeech({ voiceId: "voice_test_0001", text: "Hi", speed: 1 });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(ok.calls).toHaveLength(2);
    const busy = mockFetch([json(503, {}), json(503, {}), json(503, {})]);
    await expect(createHeyGenClient({ apiKey: key, fetchImpl: busy.impl, sleep }).getVideo("video_1")).rejects.toThrow("HTTP 503");
    expect(busy.calls).toHaveLength(3);
  });
  test("direct upload: create, PUT without the API key, then complete", async () => {
    const dir = tempDir();
    const file = join(dir, "voice-master.wav");
    const bytes = Buffer.alloc(4000, 7);
    writeFileSync(file, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const uploadHeaders = { "content-type": "audio/wav", "x-amz-checksum-sha256": "signed" };
    const { impl, calls } = mockFetch([
      json(200, { data: { asset_id: "asset_test_1", upload_url: "https://upload.example.test/slot", upload_headers: uploadHeaders, expires_in_seconds: 86400, max_bytes: 2147483648, status: "pending_upload" } }),
      new Response(null, { status: 200 }),
      json(200, { data: { asset_id: "asset_test_1", url: "https://public.example.test/voice.wav", mime_type: "audio/wav", size_bytes: 4000, status: "processing" } }),
    ]);
    const result = await createHeyGenClient({ apiKey: key, fetchImpl: impl }).uploadAudio(file, { idempotencyKey: "clone-upload-test" });
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "https://api.heygen.com/v3/assets/direct-uploads"],
      ["PUT", "https://upload.example.test/slot"],
      ["POST", "https://api.heygen.com/v3/assets/asset_test_1/complete"],
    ]);
    expect(JSON.parse(calls[0].init.body)).toEqual({ filename: "voice-master.wav", content_type: "audio/wav", size_bytes: 4000, checksum_sha256: sha });
    expect(calls[0].init.headers["Idempotency-Key"]).toBe("clone-upload-test");
    expect(calls[1].init.headers).toEqual(uploadHeaders);
    expect(calls[1].init.body.length).toBe(4000);
    expect(JSON.parse(calls[2].init.body)).toEqual({ checksum_sha256: sha });
    expect(result).toEqual({ assetId: "asset_test_1", sizeBytes: 4000, mimeType: "audio/wav", checksum: sha });
    expect(JSON.stringify(result)).not.toContain("public.example.test");
  });
  test("upload refuses a non-HTTPS slot and a size mismatch", async () => {
    const dir = tempDir();
    const file = join(dir, "voice.wav");
    writeFileSync(file, Buffer.alloc(100, 1));
    const insecure = mockFetch([json(200, { data: { asset_id: "asset_test_2", upload_url: "http://upload.example.test/slot", upload_headers: {}, max_bytes: 10000 } })]);
    await expect(createHeyGenClient({ apiKey: key, fetchImpl: insecure.impl }).uploadAudio(file)).rejects.toThrow(/unexpected response/);
    expect(insecure.calls).toHaveLength(1);
    const mismatch = mockFetch([
      json(200, { data: { asset_id: "asset_test_3", upload_url: "https://upload.example.test/slot", upload_headers: {}, max_bytes: 10000 } }),
      new Response(null, { status: 200 }),
      json(200, { data: { asset_id: "asset_test_3", mime_type: "audio/wav", size_bytes: 99, status: "processing" } }),
    ]);
    await expect(createHeyGenClient({ apiKey: key, fetchImpl: mismatch.impl }).uploadAudio(file)).rejects.toThrow(/different asset or size/);
  });
  test("lip-sync request uses the uploaded asset, 9:16 and an idempotency key", async () => {
    const { impl, calls } = mockFetch([json(200, { data: { video_id: "video_test_1", status: "waiting" } })]);
    const created = await createHeyGenClient({ apiKey: key, fetchImpl: impl }).createAvatarVideo({ avatarId: "look_test_portrait", audioAssetId: "asset_test_1", engine: "avatar_v", idempotencyKey: "clone-video-test" });
    expect(created).toEqual({ videoId: "video_test_1", status: "waiting" });
    expect(calls[0].url).toBe("https://api.heygen.com/v3/videos");
    expect(calls[0].init.headers["Idempotency-Key"]).toBe("clone-video-test");
    expect(JSON.parse(calls[0].init.body)).toEqual({ type: "avatar", avatar_id: "look_test_portrait", audio_asset_id: "asset_test_1", aspect_ratio: "9:16", resolution: "1080p", engine: { type: "avatar_v" } });
  });
  test("polls with growing delays until completed", async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = mockFetch([
      json(200, { data: { id: "video_test_1", status: "pending" } }),
      json(200, { data: { id: "video_test_1", status: "processing" } }),
      json(200, { data: { id: "video_test_1", status: "completed", video_url: "https://files.example.test/v.mp4", duration: 12.5 } }),
    ]);
    const seen = [];
    const video = await createHeyGenClient({ apiKey: key, fetchImpl: impl, sleep }).waitForVideo("video_test_1", { onStatus: (status) => seen.push(status) });
    expect(video.videoUrl).toBe("https://files.example.test/v.mp4");
    expect(seen).toEqual(["pending", "processing", "completed"]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10000, 15000]);
    expect(calls[0].url).toBe("https://api.heygen.com/v3/videos/video_test_1");
  });
  test("provider status strings are reduced to plain tokens", async () => {
    const { impl } = mockFetch([json(200, { data: { id: "video_test_1", status: "[31mprocessing" } })]);
    expect((await createHeyGenClient({ apiKey: key, fetchImpl: impl }).getVideo("video_test_1")).status).toBe("unknown");
  });
  test("a failed render reports only its failure code", async () => {
    const { impl } = mockFetch([json(200, { data: { id: "video_test_1", status: "failed", failure_code: "rendering_failed", failure_message: "private detail" } })]);
    const failure = createHeyGenClient({ apiKey: key, fetchImpl: impl }).waitForVideo("video_test_1");
    await expect(failure).rejects.toThrow(/failed \(rendering_failed\)/);
    await expect(failure).rejects.not.toThrow(/private detail/);
  });
  test("polling times out with a resume hint instead of a fake success", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms) => { clock += ms; });
    const pending = () => json(200, { data: { id: "video_test_1", status: "processing" } });
    const { impl } = mockFetch([pending(), pending(), pending()]);
    const client = createHeyGenClient({ apiKey: key, fetchImpl: impl, sleep, now: () => clock });
    await expect(client.waitForVideo("video_test_1", { timeoutMs: 30000 })).rejects.toThrow(/resume polling/);
  });
  test("downloads stream to a new file without credentials and respect the size cap", async () => {
    const dir = tempDir();
    const { impl, calls } = mockFetch([new Response(Buffer.alloc(64, 3), { status: 200 }), new Response(Buffer.alloc(64, 3), { status: 200 })]);
    const target = join(dir, "speech.wav");
    expect(await downloadToFile(audioUrl, target, { fetchImpl: impl, maxBytes: 1000 })).toBe(64);
    expect(calls[0].init.headers).toBeUndefined();
    await expect(downloadToFile(audioUrl, target, { fetchImpl: impl, maxBytes: 1000 })).rejects.toThrow(/already exists/);
    const big = mockFetch([new Response(Buffer.alloc(64, 3), { status: 200 })]);
    await expect(downloadToFile(audioUrl, join(dir, "big.wav"), { fetchImpl: big.impl, maxBytes: 10 })).rejects.toThrow(/size limit/);
    expect(existsSync(join(dir, "big.wav"))).toBe(false);
    await expect(downloadToFile("http://files.example.test/a.wav", join(dir, "x.wav"), { fetchImpl: impl, maxBytes: 10 })).rejects.toThrow(/non-HTTPS/);
  });
});

describe("audio mastering and sync math", () => {
  test("builds the documented mastering chain with the limiter's auto level off", () => {
    expect(masterFilter(masterOptions(), 9.5)).toBe("highpass=f=80,acompressor=threshold=0.1:ratio=2.5:attack=5:release=100,volume=9.5dB,alimiter=limit=0.72:level=0");
    expect(preGainFilter(masterOptions({ dynamics: "gate" }))).toBe("highpass=f=80,agate=threshold=0.015849:ratio=2:attack=10:release=200");
    expect(() => masterOptions({ dynamics: "expander" })).toThrow();
    expect(() => masterOptions({ limit: 2 })).toThrow();
  });
  test("reads the final ebur128 summary, not a progress line", () => {
    const log = "[Parsed_ebur128_0] t: 1.0 M: -30.0 S: -30.0 I: -30.0 LUFS LRA: 0.0 LU\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.3 LUFS\n\n  Loudness range:\n    LRA:         4.1 LU\n\n  True peak:\n    Peak:       -1.8 dBFS\n";
    expect(parseLoudnessSummary(log)).toEqual({ integratedLufs: -14.2, truePeakDb: -1.8 });
    expect(parseLoudnessSummary("Summary:\n Integrated loudness:\n I: -inf LUFS\n True peak:\n Peak: -inf dBFS").integratedLufs).toBe(-Infinity);
    expect(() => parseLoudnessSummary("nothing here")).toThrow(/loudness summary/);
  });
  test("judges loudness against -14 LUFS and a -1.5 dBTP ceiling", () => {
    expect(loudnessVerdict({ integratedLufs: -14.4, truePeakDb: -1.7 }).pass).toBe(true);
    expect(loudnessVerdict({ integratedLufs: -16.2, truePeakDb: -1.7 }).problems[0]).toMatch(/outside -14/);
    expect(loudnessVerdict({ integratedLufs: -14, truePeakDb: -1.5 }).problems[0]).toMatch(/true peak/);
    expect(makeupGainDb(-23.6, -14)).toBe(9.6);
    expect(() => makeupGainDb(-Infinity, -14)).toThrow(/silent/);
  });
  test("FFT round-trips", () => {
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.7) + (i % 5) / 7);
    const original = Float64Array.from(re);
    const im = new Float64Array(64);
    fft(re, im);
    fft(re, im, true);
    re.forEach((value, i) => expect(value).toBeCloseTo(original[i], 9));
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/);
  });
  const noise = (length, seed) => {
    let state = seed;
    return Float64Array.from({ length }, () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 1073741824 - 1; });
  };
  const shift = (signal, samples) => Float64Array.from(signal, (_, i) => signal[i - samples] ?? 0);
  test("estimates the render's lag by cross-correlation", () => {
    const master = noise(16000, 42);
    expect(estimateLag(master, master)).toMatchObject({ lagSamples: 0, lagMs: 0 });
    expect(estimateLag(master, master).score).toBeGreaterThan(0.99);
    expect(estimateLag(shift(master, 80), master).lagMs).toBe(5);
    expect(estimateLag(shift(master, -48), master).lagMs).toBe(-3);
    expect(syncVerdict(estimateLag(master, master)).pass).toBe(true);
    expect(syncVerdict(estimateLag(shift(master, 80), master)).problems[0]).toMatch(/offset by 5 ms/);
    expect(syncVerdict(estimateLag(shift(master, 80), master), { maxLagMs: 5 }).pass).toBe(true);
    expect(syncVerdict(estimateLag(noise(16000, 7), master)).problems.join("; ")).toMatch(/does not match/);
    expect(() => estimateLag(new Float64Array(100), new Float64Array(100))).toThrow(/half a second/);
  });
  test("remux keeps the picture, swaps in the mastered voice and caps the length", () => {
    const args = remuxArgs("render.mp4", "voice.wav", "clip.mp4", 12.5);
    expect(args).toEqual(expect.arrayContaining(["-n", "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0", "-b:a", "320k", "-t", "12.5", "+faststart"]));
    expect(args.at(-1)).toBe("clip.mp4");
    expect(pcmArgs("in.mp4", 16000, 30)).toEqual(expect.arrayContaining(["-ac", "1", "-ar", "16000", "-f", "s16le", "-"]));
    expect(() => remuxArgs("a", "b", "c", 0)).toThrow();
  });
});

describe("captions from the approved script", () => {
  test("merges whisper's split tokens", () => {
    const words = mergeWhisperTokens([
      { word: "high", startMs: 0, endMs: 200 }, { word: "-level", startMs: 200, endMs: 400 },
      { word: "10", startMs: 500, endMs: 600 }, { word: ",000", startMs: 600, endMs: 900 },
      { word: "example", startMs: 1000, endMs: 1200 }, { word: ".com", startMs: 1200, endMs: 1500 },
      { word: "-", startMs: 1600, endMs: 1650 },
    ]);
    expect(words.map((word) => word.word)).toEqual(["high-level", "10,000", "example.com", "-"]);
    expect(words[0]).toEqual({ word: "high-level", startMs: 0, endMs: 400 });
  });
  test("matches Python difflib on its documented examples", () => {
    expect(new SequenceMatcher([..."qabxcd"], [..."abycdf"]).getOpcodes()).toEqual([
      ["delete", 0, 1, 0, 0], ["equal", 1, 3, 0, 2], ["replace", 3, 4, 2, 3], ["equal", 4, 6, 3, 5], ["insert", 6, 6, 5, 6],
    ]);
    expect(new SequenceMatcher([..."abxcd"], [..."abcd"]).getMatchingBlocks()).toEqual([[0, 0, 2], [3, 2, 2], [5, 4, 0]]);
  });
  test("copies equal runs, spreads replacements and squeezes missed words", () => {
    const heard = [
      { word: "Plant", startMs: 0, endMs: 200 }, { word: "2", startMs: 300, endMs: 500 }, { word: ",000", startMs: 500, endMs: 900 },
      { word: "seeds", startMs: 950, endMs: 1300 }, { word: "then", startMs: 1400, endMs: 1600 },
      { word: "each", startMs: 2000, endMs: 2100 }, { word: "row.", startMs: 2100, endMs: 2400 },
    ];
    const { captions, stats } = alignScriptToWords("Plant two thousand seeds, then label each row.", heard, { emphasis: ["label", "seeds"] });
    expect(captions.map((word) => word.word)).toEqual(["Plant", "two", "thousand", "seeds,", "then", "label", "each", "row."]);
    expect(captions[0]).toEqual({ word: "Plant", startMs: 0, endMs: 200 });
    expect(captions.slice(1, 3)).toEqual([{ word: "two", startMs: 300, endMs: 600 }, { word: "thousand", startMs: 600, endMs: 900 }]);
    expect(captions[3]).toEqual({ word: "seeds,", startMs: 950, endMs: 1300, emphasis: true });
    expect(captions[5]).toEqual({ word: "label", startMs: 1600, endMs: 2000, emphasis: true });
    expect(stats).toMatchObject({ equal: 5, replaced: 2, missed: 1, scriptWords: 8 });
    for (let i = 1; i < captions.length; i += 1) expect(captions[i].startMs).toBeGreaterThanOrEqual(captions[i - 1].startMs);
  });
  test("refuses empty inputs", () => {
    expect(() => alignScriptToWords(" ", [{ word: "a", startMs: 0, endMs: 1 }])).toThrow(/empty/);
    expect(() => alignScriptToWords("a b", [])).toThrow(/empty/);
  });
});

describe("framing", () => {
  test("puts a 4:5 face window over a 9:16 fill, even and clamped", () => {
    const centered = landscapePrepPlan({ sourceWidth: 1280, sourceHeight: 720, faceX: 0.5 });
    expect(centered.window).toEqual({ x: 352, y: 0, width: 576, height: 720 });
    expect(centered.fill).toEqual({ x: 437, y: 0, width: 406, height: 720 });
    expect(centered.overlayY).toBe(285);
    expect(landscapePrepPlan({ sourceWidth: 1280, sourceHeight: 720, faceX: 0 }).window.x).toBe(0);
    const right = landscapePrepPlan({ sourceWidth: 1280, sourceHeight: 720, faceX: 1 });
    expect([right.window.x, right.fill.x]).toEqual([704, 874]);
    expect(landscapePrepPlan({ sourceWidth: 1281, sourceHeight: 721, faceX: 0.5 }).window.height).toBe(720);
    expect(() => landscapePrepPlan({ sourceWidth: 720, sourceHeight: 1280, faceX: 0.5 })).toThrow(/not landscape enough/);
    expect(() => landscapePrepPlan({ sourceWidth: 1280, sourceHeight: 720, faceX: 1.2 })).toThrow(/0 \(left edge\)/);
    const filter = landscapePrepFilter(centered);
    expect(filter).toContain("crop=406:720:437:0,scale=1080:1920");
    expect(filter).toContain("crop=576:720:352:0,scale=1080:1350:flags=lanczos");
    expect(filter).toContain("boxblur=30:2,eq=brightness=-0.12:saturation=0.85");
    expect(filter).toContain("overlay=0:285");
    expect(landscapePrepArgs("r.mp4", "v.wav", "o.mp4", centered, 9)).toEqual(expect.arrayContaining(["-map", "[v]", "1:a:0", "libx264", "-t", "9", "+faststart"]));
  });
  test("keeps B-roll crops inside the frame and tight enough to read on a phone", () => {
    const clip = { sourceWidth: 1280, sourceHeight: 720 };
    expect(validateClipCrop({ ...clip, crop: { x: 300, y: 100, width: 600, height: 400 } })).toEqual({ x: 300, y: 100, width: 600, height: 400 });
    expect(() => validateClipCrop({ ...clip, crop: { x: 0, y: 0, width: 1280, height: 720 } })).toThrow(/unreadable on a phone/);
    expect(() => validateClipCrop({ ...clip, crop: { x: 900, y: 0, width: 600, height: 400 } })).toThrow(/outside/);
    expect(() => validateClipCrop({ ...clip, crop: { x: 0.5, y: 0, width: 600, height: 400 } })).toThrow(/whole pixels/);
    expect(validateClipCrop({ ...clip, crop: { x: 0, y: 0, width: 800, height: 400 } }, { min: 400, max: 800 }).width).toBe(800);
  });
  test.each(["../secret.mp4", "/abs/clip.mp4", "https://example.test/c.mp4", "a//b.mp4", "./a.mp4"])("refuses media path %s", (src) => {
    expect(() => publicMediaPath(src)).toThrow();
  });
});

describe("look rotation", () => {
  const consecutiveRepeats = (plan, previous) => plan.filter((item, i) => item.look === (i ? plan[i - 1].look : previous)).length;
  test("never repeats a look back to back and balances use", () => {
    const plan = assignLooks(["s1", "s2", "s3", "s4", "s5"], ["desk-a", "desk-b", "desk-c"]);
    expect(consecutiveRepeats(plan)).toBe(0);
    const counts = ["desk-a", "desk-b", "desk-c"].map((look) => plan.filter((item) => item.look === look).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
  test("respects the look that ended the previous batch", () => {
    const plan = assignLooks(["s1", "s2"], ["desk-a", "desk-b"], { previous: "desk-a" });
    expect(plan.map((item) => item.look)).toEqual(["desk-b", "desk-a"]);
    expect(assignLooks(["s1"], ["desk-a", "desk-b"], { previous: "retired" })[0].look).toBe("desk-a");
  });
  test("errors when a repeat cannot be avoided", () => {
    expect(() => assignLooks(["s1", "s2"], ["desk-a"])).toThrow(/one look/);
    expect(() => assignLooks(["s1"], ["desk-a"], { previous: "desk-a" })).toThrow(/one look/);
    expect(assignLooks(["s1"], ["desk-a"])).toEqual([{ piece: "s1", look: "desk-a" }]);
    expect(() => assignLooks(["s1", "s1"], ["desk-a", "desk-b"])).toThrow(/unique/);
    expect(() => assignLooks(["s1"], [])).toThrow(/No looks/);
  });
});

describe("SplicedShort props", () => {
  const job = jobSchema.parse(example("clone-job.example.json"));
  const captions = job.script.split(/\s+/).map((word, i) => ({ word, startMs: 100 + i * 300, endMs: 100 + i * 300 + 250 }));
  const build = (overrides = {}) => buildSplicedShortProps({ src: "clone/practice/clip.mp4", durationSec: 16, captions, job, ...overrides });
  test("emits the SplicedShort contract as pure data", () => {
    const props = build();
    expect(() => splicedShortPropsSchema.parse(props)).not.toThrow();
    expect(props.segments).toEqual([{ src: "clone/practice/clip.mp4", fromFrame: 0, toFrame: 480, centerX: 0.5, zoom: 1 }]);
    expect(props.wordsPerPage).toBe(3);
    const before = findPhrase(props.captions, "Before you water,");
    expect(props.cutaways).toEqual([{
      type: "clip", atMs: props.captions[before].startMs - 60,
      durMs: props.captions[findPhrase(props.captions, "into the soil.") + 2].endMs + 120 - (props.captions[before].startMs - 60),
      src: "clone/practice/soil-check.mp4", sourceFrom: 0, crop: { x: 340, y: 120, width: 600, height: 480 },
      sourceWidth: 1280, sourceHeight: 720, eyebrow: "Check the soil first", whoosh: false,
    }]);
    expect(props.kickers[0]).toEqual({ atMs: 100, durMs: 3000, text: "Stop overwatering" });
    expect(props.kickers[1].atMs).toBe(props.captions[findPhrase(props.captions, "Then give the pot")].startMs);
  });
  test("clips captions at the end of the video", () => {
    const props = build({ durationSec: 10, job: { ...job, kickers: [], broll: [] } });
    expect(props.captions.every((word) => word.startMs < 10000 && word.endMs <= 10000)).toBe(true);
    expect(props.captions.length).toBeLessThan(captions.length);
  });
  test("refuses unreadable crops, unknown phrases and timing past the end", () => {
    const wide = { ...job, broll: [{ ...job.broll[0], crop: { x: 0, y: 0, width: 1280, height: 720 } }] };
    expect(() => build({ job: wide })).toThrow(/unreadable on a phone/);
    expect(() => build({ job: { ...job, kickers: [{ atPhrase: "not in the script", durMs: 1000, text: "x" }] } })).toThrow(/not in the approved script/);
    expect(() => build({ job: { ...job, kickers: [{ atMs: 20000, durMs: 1000, text: "late" }] } })).toThrow(/after the clip ends/);
    expect(() => build({ src: "../outside.mp4" })).toThrow(/relative to public/);
  });
});

describe("clone CLI (no network, no media)", () => {
  const job = example("clone-job.example.json");
  const consentArgs = ["--consent", "clone-private/consent/record.json"];
  const quiet = () => {};
  test("refuses every command without a consent record", async () => {
    for (const command of ["plan", "speech", "master", "upload", "lipsync", "sync", "captions", "looks", "props"]) {
      await expect(runClone([command], { root: tempRoot(), log: quiet })).rejects.toThrow(/--consent/);
    }
  });
  test("speech previews by default: no request, no key, no files", async () => {
    const root = tempRoot({ config: testConfig, job });
    const fetchImpl = vi.fn();
    const lines = [];
    const slug = "dryrun-test-" + Date.now();
    await runClone(["speech", ...consentArgs, "--slug", slug, "--job", "brand-props/job.json"], { root, env: {}, fetchImpl, log: (line) => lines.push(line) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/DRY RUN: POST \/v3\/models\/audio\/tts with voice voic\*\*\*\*, model heygen-voice-1, speed 1\.1/);
    expect(lines.join("\n")).not.toContain("voice_test_0001");
    expect(existsSync(join(ROOT, "out", "clone", slug))).toBe(false);
  });
  test("--run without HEYGEN_API_KEY stops before any request or output", async () => {
    const root = tempRoot({ config: testConfig, job });
    const fetchImpl = vi.fn();
    const slug = "nokey-test-" + Date.now();
    await expect(runClone(["speech", ...consentArgs, "--slug", slug, "--job", "brand-props/job.json", "--run"], { root, env: {}, fetchImpl, log: quiet })).rejects.toThrow(/HEYGEN_API_KEY is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(join(ROOT, "out", "clone", slug))).toBe(false);
  });
  test("speech needs an explicit speed", async () => {
    const root = tempRoot({ config: { ...testConfig, voice: { voiceId: "voice_test_0001" } }, job });
    await expect(runClone(["speech", ...consentArgs, "--slug", "practice", "--job", "brand-props/job.json"], { root, log: quiet })).rejects.toThrow(/Choose a speed/);
  });
  test("consent is checked before config, job scope and media", async () => {
    const voiceOnly = tempRoot({ consent: consentRecord({ authorizes: { voice: true, likeness: false } }) });
    await expect(runClone(["lipsync", ...consentArgs, "--slug", "practice", "--look", "desk-a"], { root: voiceOnly, log: quiet })).rejects.toThrow(/does not authorize the likeness/);
    const narrow = tempRoot({ consent: consentRecord({ platforms: ["tiktok"] }), config: testConfig, job });
    await expect(runClone(["speech", ...consentArgs, "--slug", "practice", "--job", "brand-props/job.json"], { root: narrow, log: quiet })).rejects.toThrow(/platform "youtube-shorts"/);
    const template = tempRoot({ consent: example("clone-consent.example.json"), config: testConfig, job });
    await expect(runClone(["plan", ...consentArgs, "--slug", "practice", "--job", "brand-props/job.json"], { root: template, log: quiet })).rejects.toThrow(/example consent template/);
  });
  test("rejects unknown flags and commands", async () => {
    await expect(runClone(["speech", ...consentArgs, "--publish"], { root: tempRoot(), log: quiet })).rejects.toThrow();
    await expect(runClone(["publish", ...consentArgs], { root: tempRoot(), log: quiet })).rejects.toThrow(/Unknown command/);
  });
  test("plan previews the whole route", async () => {
    const lines = [];
    await runClone(["plan", ...consentArgs, "--slug", "practice", "--job", "brand-props/job.json"], { root: tempRoot({ config: testConfig, job }), log: (line) => lines.push(line) });
    const text = lines.join("\n");
    expect(text).toContain("No credentials read, no network calls");
    expect(text).toContain("POST /v3/assets/direct-uploads");
    expect(text).toContain("Nothing is ever published");
  });
  test("looks rotates from the saved state and saves only a look name", async () => {
    const root = tempRoot({ config: testConfig });
    const first = await runClone(["looks", ...consentArgs, "--batch", "s1,s2,s3", "--save-state"], { root, log: quiet, today: TODAY });
    const state = JSON.parse(readFileSync(join(root, "clone-private/state.json"), "utf8"));
    expect(state).toEqual({ schema: "clone-state/1", lastLook: first.at(-1).look, updatedOn: TODAY });
    const second = await runClone(["looks", ...consentArgs, "--batch", "s4"], { root, log: quiet });
    expect(second[0].look).not.toBe(state.lastLook);
  });
  test("look names must be the config's own entries", async () => {
    const root = tempRoot({ config: testConfig });
    await expect(runClone(["lipsync", ...consentArgs, "--slug", "practice", "--look", "constructor"], { root, log: quiet })).rejects.toThrow(/is not in clone-private\/config.json/);
  });
  test("lipsync previews the shape actually requested for a look", async () => {
    const root = tempRoot({ config: testConfig });
    const preview = async (...extra) => {
      const lines = [];
      await runClone(["lipsync", ...consentArgs, "--slug", "aspect-test-" + Date.now(), "--look", "desk-b", ...extra], { root, log: (line) => lines.push(line) });
      return lines.join(" | ");
    };
    expect(await preview()).toContain("aspect 16:9");
    expect(await preview("--aspect", "9:16")).toContain("aspect 9:16");
  });
  test("placeholder config values are refused", async () => {
    const root = tempRoot({ config: example("clone-config.example.json") });
    await expect(runClone(["looks", ...consentArgs, "--batch", "s1"], { root, log: quiet })).rejects.toThrow(/placeholder/);
  });
});

const ffmpegReady = hasTool("ffmpeg") && hasTool("ffprobe");

describe.skipIf(!ffmpegReady)("FFmpeg media steps (synthetic media)", () => {
  let dir;
  let speech;
  let master;
  let report;
  const speechLike = "aevalsrc='(0.45*sin(2*PI*180*t)+0.25*sin(2*PI*360*t)+0.15*sin(2*PI*900*t))"
    + "*gt(sin(2*PI*2.3*t)+0.4*sin(2*PI*0.37*t),0.1)*(0.6+0.4*sin(2*PI*0.21*t))+0.9*lt(mod(t,2.1),0.01)*sin(2*PI*1200*t):s=44100:d=6'";
  const render = (name, audio, size, audioFilter) => {
    const out = join(dir, name);
    runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=" + size + ":rate=25", "-i", audio,
      ...(audioFilter ? ["-af", audioFilter] : []), "-t", "6", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out]);
    return out;
  };
  beforeAll(() => {
    dir = tempDir();
    speech = join(dir, "speech.wav");
    runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", speechLike, "-c:a", "pcm_s16le", speech]);
    master = join(dir, "master.wav");
    report = masterVoice({ input: speech, wavOut: master, checkOut: join(dir, "master-check.m4a") });
  }, 60000);
  test("masters to about -14 LUFS with true peak under -1.5 dBTP after AAC", () => {
    expect(Math.abs(report.afterAac.integratedLufs + 14)).toBeLessThanOrEqual(1);
    expect(report.afterAac.truePeakDb).toBeLessThan(-1.5);
    expect(probeMedia(master)).toMatchObject({ hasAudio: true, hasVideo: false });
    expect(() => masterVoice({ input: speech, wavOut: master, checkOut: join(dir, "other.m4a") })).toThrow(/already exists/);
  });
  test("passes an in-sync render and remuxes the mastered voice onto it", () => {
    const result = checkSyncAndMux({ render: render("render.mp4", master, "640x360"), master, output: join(dir, "clip.mp4") });
    expect(Math.round(result.lag.lagMs)).toBe(0);
    expect(result.lag.score).toBeGreaterThan(0.9);
    expect(result.mode).toBe("copy");
    expect(result.output.width).toBe(640);
    expect(result.output.durationSec).toBeLessThanOrEqual(result.render.durationSec + 0.05);
  }, 60000);
  test("refuses a render whose audio is 40 ms late and writes nothing", () => {
    const output = join(dir, "late-clip.mp4");
    expect(() => checkSyncAndMux({ render: render("late.mp4", master, "640x360", "adelay=40"), master, output })).toThrow(/offset by 4\d(\.\d+)? ms/);
    expect(existsSync(output)).toBe(false);
  }, 60000);
  test("prepares a 16:9 render as 9:16 with the face window and mastered voice", () => {
    const result = checkSyncAndMux({ render: render("wide.mp4", master, "1280x720"), master, output: join(dir, "wide-clip.mp4"), faceX: 0.3 });
    expect(result.mode).toBe("landscape-prep");
    expect([result.output.width, result.output.height]).toEqual([1080, 1920]);
    expect(result.plan.window.width % 2).toBe(0);
  }, 120000);
});
