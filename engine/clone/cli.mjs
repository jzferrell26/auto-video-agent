// Optional clone-video route: approved script to a 9:16 talking-head Short with the creator's
// own HeyGen voice clone and avatar look, audio first. Every command checks a written consent
// record before anything else. Commands that spend HeyGen credits or upload media only print a
// preview unless --run is passed. Nothing here publishes anywhere.
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ROOT, assertNew, main, outputDirectory, slugSchema, wordsSchema, writeJson } from "../pipeline/runtime.mjs";
import { localToday, mask, providerIdSchema } from "./common.mjs";
import { evaluateConsent, requireConsent } from "./consent.mjs";
import { CONFIG_FILE, loadConfig, loadJob, loadState, saveState } from "./config.mjs";
import { alignScriptToWords } from "./captions.mjs";
import {
  ASPECT_RATIOS, CREATE_UPLOAD_PATH, CREATE_VIDEO_PATH, DEFAULT_TTS_MODEL, MAX_AVATAR_AUDIO_SECONDS,
  MAX_LIPSYNC_AUDIO_BYTES, RESOLUTIONS, SPEECH_PATH, SPEED_RANGE, TTS_MODELS, VIDEO_ENGINES,
  createHeyGenClient, downloadToFile, sha256Hex,
} from "./heygen.mjs";
import { assignLooks } from "./looks.mjs";
import { checkSyncAndMux, masterVoice, probeMedia } from "./media.mjs";
import { buildSplicedShortProps } from "./props.mjs";

const COMMANDS = {
  plan: { needs: ["voice", "likeness"], slug: true, job: true, options: [] },
  speech: { needs: ["voice"], slug: true, job: true, options: ["voice-id", "speed", "model", "run"] },
  master: { needs: ["voice"], slug: true, job: false, options: ["input", "dynamics", "target-lufs", "makeup-db"] },
  // upload and lipsync send media to the provider, so they re-check the job's use and platforms
  // against the consent record, not only its expiry.
  upload: { needs: ["voice"], slug: true, job: true, options: ["run"] },
  lipsync: { needs: ["voice", "likeness"], slug: true, job: true, options: ["look", "avatar-id", "aspect", "engine", "resolution", "timeout-min", "run"] },
  sync: { needs: ["voice", "likeness"], slug: true, job: false, options: ["max-lag-ms", "min-score", "face-x"] },
  captions: { needs: ["voice"], slug: true, job: true, options: ["words", "min-match"] },
  looks: { needs: ["likeness"], slug: false, job: false, options: ["batch", "previous", "save-state"] },
  props: { needs: ["voice", "likeness"], slug: true, job: true, options: [] },
};

const OPTION_TYPES = {
  consent: "string", job: "string", slug: "string", run: "boolean", help: "boolean",
  "voice-id": "string", speed: "string", model: "string", input: "string", dynamics: "string",
  "target-lufs": "string", "makeup-db": "string", look: "string", "avatar-id": "string", aspect: "string",
  engine: "string", resolution: "string", "timeout-min": "string", "max-lag-ms": "string", "min-score": "string",
  "face-x": "string", words: "string", "min-match": "string", batch: "string", previous: "string", "save-state": "boolean",
};

export const USAGE = `Usage: npm run clone -- <command> --consent clone-private/consent/<record>.json [options]

Commands (in order):
  plan      --slug <name> --job <job.json>         Preview the whole route. No network, no media.
  speech    --slug <name> --job <job.json> [--speed 1.1] [--voice-id <id>] [--model <m>] [--run]
  master    --slug <name> [--input <wav>] [--dynamics compressor|gate] [--target-lufs -14] [--makeup-db <dB>]
  upload    --slug <name> --job <job.json> [--run]
  lipsync   --slug <name> --job <job.json> (--look <name> | --avatar-id <id>) [--aspect 9:16] [--engine <e>] [--resolution 1080p] [--timeout-min 20] [--run]
  sync      --slug <name> [--max-lag-ms 0] [--min-score 0.5] [--face-x 0.5]
  captions  --slug <name> --job <job.json> --words <whisper.words.json> [--min-match 0.6]
  looks     --batch <piece,piece,...> [--previous <look>] [--save-state]
  props     --slug <name> --job <job.json>

speech, upload and lipsync spend HeyGen credits or upload media, so they only preview
unless --run is passed. Every command refuses to run without a valid consent record.
See docs/clone-video.md.`;

function numberOption(values, name, { min, max, fallback } = {}) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new Error("--" + name + " must be a number" + (min !== undefined ? " from " + min + " to " + max : "") + ".");
  }
  return value;
}

function pathInside(root, path, label) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || resolve(rel) === rel) throw new Error(label + " must be inside the repository.");
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error(label + " was not found.");
  return absolute;
}

function readReport(path, schema, missing) {
  if (!existsSync(path)) throw new Error(missing);
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("A previous step's report is not valid JSON: " + relative(ROOT, path)); }
  return schema.parse(value);
}

export function runPaths(slug) {
  const run = join(ROOT, "out", "clone", slug);
  return {
    runDir: "out/clone/" + slug,
    run,
    speechRaw: join(run, "speech-raw.wav"),
    speechReport: join(run, "speech-report.json"),
    master: join(run, "voice-master.wav"),
    masterCheck: join(run, "voice-master-check.m4a"),
    masterReport: join(run, "master-report.json"),
    uploadReport: join(run, "upload-report.json"),
    lipsyncJob: join(run, "lipsync-job.json"),
    render: join(run, "heygen-render.mp4"),
    lipsyncReport: join(run, "lipsync-report.json"),
    syncReport: join(run, "sync-report.json"),
    captions: join(run, "captions.json"),
    captionsReport: join(run, "captions-report.json"),
    clipDir: "public/clone/" + slug,
    clip: join(ROOT, "public", "clone", slug, "clip.mp4"),
    clipSrc: "clone/" + slug + "/clip.mp4",
    props: join(ROOT, "brand-props", "clone-" + slug + ".json"),
  };
}

function readApiKey(env, root) {
  if (env === process.env) {
    const envFile = join(root, ".env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const key = env.HEYGEN_API_KEY;
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("HEYGEN_API_KEY is not set. Put it in your environment or the ignored .env file; it is never printed or saved.");
  }
  return key.trim();
}

const masterReportSchema = z.object({ durationSec: z.number().positive() }).passthrough();
const uploadReportSchema = z.object({ assetId: providerIdSchema, sizeBytes: z.number().int().positive() }).passthrough();
const lipsyncJobSchema = z.object({
  videoId: providerIdSchema, orientation: z.enum(["portrait", "landscape"]),
  faceX: z.number().min(0).max(1).nullable(),
}).passthrough();
const LANDSCAPE_ASPECTS = ["16:9", "5:4"];
const alignedCaptionsSchema = z.array(z.object({
  word: z.string().min(1), startMs: z.number().min(0), endMs: z.number().min(0), emphasis: z.boolean().optional(),
}).strict());
const syncReportSchema = z.object({ src: z.string(), output: z.object({ durationSec: z.number().positive() }).passthrough() }).passthrough();

export async function runClone(argv, deps = {}) {
  const { root = ROOT, env = process.env, fetchImpl = globalThis.fetch, log = console.log, today = localToday(), sleep } = deps;
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    log(USAGE);
    return;
  }
  const spec = COMMANDS[command];
  if (!spec) throw new Error("Unknown command \"" + String(command).slice(0, 40) + "\". Use --help.");
  const allowed = ["consent", "help", ...(spec.slug ? ["slug"] : []), ...(spec.job ? ["job"] : []), ...spec.options];
  const options = Object.fromEntries(allowed.map((name) => [name, { type: OPTION_TYPES[name] }]));
  const { values, positionals } = parseArgs({ args: rest, options, strict: true, allowPositionals: false });
  if (positionals.length) throw new Error("Unexpected arguments. Use --help.");
  if (values.help) {
    log(USAGE);
    return;
  }

  // 1. Consent first, before any file, provider or media work.
  let consent = requireConsent(values.consent, { root, needs: spec.needs, today });
  const job = spec.job ? loadJob(values.job, { root }) : undefined;
  if (job) consent = evaluateConsent(consent, { needs: spec.needs, today, use: job.use, platforms: job.platforms });
  const slug = spec.slug ? slugSchema.parse(values.slug) : undefined;
  const p = slug ? runPaths(slug) : undefined;
  const context = { consent, job, slug, p, values, root, env, fetchImpl, log, today, sleep };
  return HANDLERS[command](context);
}

const HANDLERS = {
  async plan({ consent, job, slug, log, root }) {
    const config = loadConfig({ root, required: false });
    const words = job.script.split(/\s+/).filter(Boolean).length;
    log("DRY RUN for \"" + slug + "\". No credentials read, no network calls, no media created.");
    log("Consent " + consent.id + ": voice " + consent.authorizes.voice + ", likeness " + consent.authorizes.likeness + ", expires " + consent.expires + ".");
    log("Script approved on " + job.scriptApprovedOn + ": " + words + " words, " + job.script.length + " characters; use " + job.use + "; platforms " + job.platforms.join(", ") + ".");
    log(config ? "Private config: voice " + mask(config.voice.voiceId) + ", looks " + Object.keys(config.looks).join(", ") + "." : "Private config: missing. Create " + CONFIG_FILE + " from engine/examples/clone-config.example.json.");
    log("Steps:");
    log("  1. speech    POST " + SPEECH_PATH + "  (spends credits; needs --run)");
    log("  2. master    local FFmpeg: high-pass, compressor or gate, makeup gain, limiter; checks -14 LUFS and true peak under -1.5 dBTP after AAC");
    log("  3. upload    POST " + CREATE_UPLOAD_PATH + ", PUT to the presigned URL, POST /v3/assets/{asset_id}/complete  (uploads media; needs --run)");
    log("  4. lipsync   POST " + CREATE_VIDEO_PATH + " (type avatar, 9:16 or 16:9), poll GET /v3/videos/{video_id}, download  (spends credits; needs --run)");
    log("  5. sync      local lag check against the mastered voice, then remux (or 16:9 prep) into " + runPaths(slug).clipDir + "/clip.mp4");
    log("  6. captions  approved script words timed from your whisper words file");
    log("  7. props     brand-props/clone-" + slug + ".json for the SplicedShort composition");
    log("Nothing is ever published. Platform AI-disclosure settings are yours to apply at upload; see docs/clone-video.md.");
  },

  async speech({ consent, job, p, values, root, env, fetchImpl, log, slug, sleep }) {
    const config = loadConfig({ root, required: values["voice-id"] === undefined });
    const voiceId = providerIdSchema.parse(values["voice-id"] ?? config.voice.voiceId);
    const speed = numberOption(values, "speed", { min: SPEED_RANGE.min, max: SPEED_RANGE.max, fallback: config?.voice.speed });
    if (speed === undefined) throw new Error("Choose a speed from " + SPEED_RANGE.min + " to " + SPEED_RANGE.max + ", for example --speed 1.1. The API does not inherit your app setting, so it is always sent.");
    const model = values.model ?? config?.voice.model ?? DEFAULT_TTS_MODEL;
    if (!TTS_MODELS.includes(model)) throw new Error("--model must be one of: " + TTS_MODELS.join(", ") + ".");
    const language = job.language ?? config?.voice.language;
    log((values.run ? "RUN" : "DRY RUN") + ": POST " + SPEECH_PATH + " with voice " + mask(voiceId) + ", model " + model + ", speed " + speed + ", " + job.script.length + " characters, language " + (language ?? "auto-detected") + ".");
    if (model !== DEFAULT_TTS_MODEL) log("Note: speed applies to professional voice clones only; instant voices accept and ignore it (HeyGen docs).");
    if (!values.run) {
      log("This spends HeyGen credits. Review the script and settings, then add --run.");
      return;
    }
    const client = createHeyGenClient({ apiKey: readApiKey(env, root), fetchImpl, ...(sleep ? { sleep } : {}) });
    outputDirectory(p.runDir);
    assertNew([p.speechRaw, p.speechReport]);
    const result = await client.generateSpeech({ voiceId, text: job.script, model, speed, language });
    let bytes;
    try {
      bytes = await downloadToFile(result.audioUrl, p.speechRaw, { fetchImpl, maxBytes: 200_000_000, operation: "Speech download" });
    } catch (error) {
      // The speech was generated and billed before this download; say so before a rerun pays again.
      throw new Error((error instanceof Error ? error.message : "Speech download failed.") + " The speech was already generated, so these credits are spent; a rerun generates (and bills) it again.");
    }
    writeJson(p.speechReport, {
      createdAt: new Date().toISOString(), consentId: consent.id, voice: mask(voiceId), model, speed,
      language: language ?? "auto", characters: job.script.length, durationSec: result.durationSec, bytes,
    });
    log("Wrote " + p.runDir + "/speech-raw.wav (" + result.durationSec.toFixed(2) + " s). Listen to it, then run: npm run clone -- master --slug " + slug + " --consent <record>");
  },

  async master({ consent, p, values, root, log, slug }) {
    const input = values.input ? pathInside(root, values.input, "--input") : p.speechRaw;
    if (!existsSync(input)) throw new Error("No speech to master. Run the speech step first, or pass --input with the person's own recording.");
    const overrides = {};
    if (values.dynamics !== undefined) overrides.dynamics = values.dynamics;
    const target = numberOption(values, "target-lufs", { min: -40, max: -5 });
    if (target !== undefined) overrides.targetLufs = target;
    const makeupDb = numberOption(values, "makeup-db", { min: -20, max: 30 });
    outputDirectory(p.runDir);
    assertNew([p.master, p.masterCheck, p.masterReport]);
    const report = masterVoice({ input, wavOut: p.master, checkOut: p.masterCheck, overrides, makeupDb });
    const durationSec = probeMedia(p.master).durationSec;
    writeJson(p.masterReport, { createdAt: new Date().toISOString(), consentId: consent.id, source: values.input ? "recording" : "speech", durationSec, ...report });
    log("Mastered: " + report.afterAac.integratedLufs + " LUFS, true peak " + report.afterAac.truePeakDb + " dBTP after AAC (makeup " + report.makeupDb + " dB). Listen to " + p.runDir + "/voice-master-check.m4a, then upload with: npm run clone -- upload --slug " + slug + " --job <job.json> --consent <record>");
  },

  async upload({ consent, p, values, root, env, fetchImpl, log, slug, sleep }) {
    const master = readReport(p.masterReport, masterReportSchema, "Master the voice first (npm run clone -- master).");
    if (!existsSync(p.master)) throw new Error("The mastered voice file is missing. Re-run the master step under a new slug.");
    const size = statSync(p.master).size;
    if (size > MAX_LIPSYNC_AUDIO_BYTES) throw new Error("The mastered voice is over 32 MB, HeyGen's documented lip-sync audio limit. Split the script.");
    if (master.durationSec > MAX_AVATAR_AUDIO_SECONDS) throw new Error("The mastered voice is over 600 seconds, HeyGen's documented avatar audio limit. Split the script.");
    log((values.run ? "RUN" : "DRY RUN") + ": upload voice-master.wav (" + size + " bytes, " + master.durationSec.toFixed(2) + " s) with POST " + CREATE_UPLOAD_PATH + ", a PUT to the presigned URL (no API key), and POST /v3/assets/{asset_id}/complete.");
    log("HeyGen stores the file in your workspace and returns a public URL for it; this tool never prints or saves that URL. Delete the asset in HeyGen when you no longer need it.");
    if (!values.run) {
      log("This uploads the cloned voice to an external service. Confirm consent covers it, then add --run.");
      return;
    }
    const client = createHeyGenClient({ apiKey: readApiKey(env, root), fetchImpl, ...(sleep ? { sleep } : {}) });
    assertNew([p.uploadReport]);
    const checksum = sha256Hex(readFileSync(p.master));
    const result = await client.uploadAudio(p.master, { idempotencyKey: "clone-upload-" + slug + "-" + checksum.slice(0, 16) });
    writeJson(p.uploadReport, { uploadedAt: new Date().toISOString(), consentId: consent.id, ...result });
    log("Uploaded as asset " + mask(result.assetId) + ". Next: npm run clone -- lipsync --slug " + slug + " --job <job.json> --look <name> --consent <record>");
  },

  async lipsync({ consent, p, values, root, env, fetchImpl, log, slug, sleep }) {
    if (values.look !== undefined && values["avatar-id"] !== undefined) throw new Error("Pass --look or --avatar-id, not both.");
    if (values.look === undefined && values["avatar-id"] === undefined) throw new Error("Pass --look <name> from your private config, or --avatar-id <id>.");
    const config = loadConfig({ root, required: values.look !== undefined });
    const look = values.look !== undefined && Object.hasOwn(config.looks, values.look) ? config.looks[values.look] : undefined;
    if (values.look !== undefined && !look) throw new Error("Look \"" + values.look + "\" is not in " + CONFIG_FILE + ".");
    const avatarId = providerIdSchema.parse(values["avatar-id"] ?? look.avatarId);
    if (values.aspect !== undefined && !ASPECT_RATIOS.includes(values.aspect)) throw new Error("--aspect must be one of: " + ASPECT_RATIOS.join(", ") + ".");
    const aspectRatio = values.aspect ?? (look && look.orientation === "landscape" ? "16:9" : "9:16");
    // The render's shape follows the aspect actually requested, so sync reframes only wide renders.
    const orientation = LANDSCAPE_ASPECTS.includes(aspectRatio) ? "landscape" : "portrait";
    const engine = values.engine ?? config?.video.engine;
    if (engine !== undefined && !VIDEO_ENGINES.includes(engine)) throw new Error("--engine must be one of: " + VIDEO_ENGINES.join(", ") + ".");
    const resolution = values.resolution ?? config?.video.resolution ?? "1080p";
    if (!RESOLUTIONS.includes(resolution)) throw new Error("--resolution must be one of: " + RESOLUTIONS.join(", ") + ".");
    const timeoutMin = numberOption(values, "timeout-min", { min: 1, max: 120, fallback: 20 });
    const faceX = orientation === "landscape" ? (look ? look.faceX : 0.5) : null;
    const resuming = existsSync(p.lipsyncJob);
    if (existsSync(p.render)) throw new Error("This slug already has a downloaded render. Run the sync step, or use a new slug.");
    const upload = resuming || !existsSync(p.uploadReport) ? undefined : readReport(p.uploadReport, uploadReportSchema, "");
    if (!resuming && !upload && values.run) throw new Error("Upload the mastered voice first (npm run clone -- upload --run).");
    if (resuming) {
      log((values.run ? "RUN" : "DRY RUN") + ": resume polling the video already requested for \"" + slug + "\" (GET /v3/videos/{video_id}), then download it. No new video is requested.");
    } else {
      log((values.run ? "RUN" : "DRY RUN") + ": POST " + CREATE_VIDEO_PATH + " type avatar, look " + (values.look ?? "(by id)") + " " + mask(avatarId) + ", audio asset " + (upload ? mask(upload.assetId) : "(from the upload step)")
        + ", aspect " + aspectRatio + ", resolution " + resolution + ", engine " + (engine ?? "default (Avatar IV)") + "; then poll and download.");
    }
    if (!values.run) {
      log("This spends HeyGen credits. A submitted request is not a finished video: the tool waits for status completed and downloads the file before reporting success. Add --run to proceed.");
      return;
    }
    const client = createHeyGenClient({ apiKey: readApiKey(env, root), fetchImpl, ...(sleep ? { sleep } : {}) });
    outputDirectory(p.runDir);
    assertNew([p.lipsyncReport]);
    let jobRecord;
    if (resuming) {
      jobRecord = readReport(p.lipsyncJob, lipsyncJobSchema, "Missing lipsync job record.");
    } else {
      const idempotencyKey = "clone-video-" + slug + "-" + sha256Hex([upload.assetId, avatarId, aspectRatio, resolution, engine ?? ""].join("|")).slice(0, 16);
      const created = await client.createAvatarVideo({ avatarId, audioAssetId: upload.assetId, aspectRatio, resolution, engine, title: "clone " + slug, idempotencyKey });
      jobRecord = { videoId: created.videoId, status: "accepted", look: values.look ?? null, orientation, faceX, aspectRatio, resolution, engine: engine ?? null, requestedAt: new Date().toISOString(), consentId: consent.id };
      writeJson(p.lipsyncJob, jobRecord);
      log("Request accepted as video " + mask(created.videoId) + ". This is not a finished video yet; polling.");
    }
    let lastStatus = "";
    const video = await client.waitForVideo(jobRecord.videoId, {
      timeoutMs: timeoutMin * 60000,
      onStatus: (status) => { if (status !== lastStatus) { lastStatus = status; log("Status: " + status); } },
    });
    await downloadToFile(video.videoUrl, p.render, { fetchImpl, maxBytes: 2_000_000_000, operation: "Video download" });
    const probe = probeMedia(p.render);
    writeJson(p.lipsyncReport, { downloadedAt: new Date().toISOString(), consentId: consent.id, video: mask(jobRecord.videoId), status: video.status, providerDurationSec: video.durationSec, file: probe });
    log("Downloaded " + p.runDir + "/heygen-render.mp4 (" + probe.width + "x" + probe.height + ", " + probe.durationSec.toFixed(2) + " s). Next: npm run clone -- sync --slug " + slug + " --consent <record>");
  },

  async sync({ consent, p, values, log, slug }) {
    if (!existsSync(p.render)) throw new Error("No downloaded render. Run the lipsync step with --run first.");
    if (!existsSync(p.master)) throw new Error("The mastered voice is missing.");
    const recorded = existsSync(p.lipsyncJob) ? readReport(p.lipsyncJob, lipsyncJobSchema, "") : undefined;
    const faceX = numberOption(values, "face-x", { min: 0, max: 1, fallback: recorded && recorded.orientation === "landscape" ? recorded.faceX ?? 0.5 : undefined });
    const maxLagMs = numberOption(values, "max-lag-ms", { min: 0, max: 500, fallback: 0 });
    const minScore = numberOption(values, "min-score", { min: 0, max: 1, fallback: 0.5 });
    outputDirectory(p.clipDir);
    assertNew([p.clip, p.syncReport]);
    const report = checkSyncAndMux({ render: p.render, master: p.master, output: p.clip, faceX, maxLagMs, minScore });
    writeJson(p.syncReport, { checkedAt: new Date().toISOString(), consentId: consent.id, src: p.clipSrc, ...report });
    log("Sync: lag " + report.lag.lagMs + " ms (allowed " + maxLagMs + "), match " + report.lag.score + ". Wrote " + p.clipDir + "/clip.mp4 (" + report.output.width + "x" + report.output.height + ", " + report.output.durationSec.toFixed(2) + " s, " + report.mode + ").");
    log("Next: transcribe the mastered voice for word timings (python engine/pipeline/transcribe_full.py " + p.runDir + "/voice-master.wav), then npm run clone -- captions --slug " + slug + " ...");
  },

  async captions({ consent, job, p, values, root, log }) {
    if (values.words === undefined) throw new Error("Pass --words with the whisper word list for this piece's mastered voice.");
    let words;
    try { words = wordsSchema.parse(JSON.parse(readFileSync(pathInside(root, values.words, "--words"), "utf8"))); } catch (error) {
      if (error instanceof z.ZodError) throw error;
      throw error instanceof SyntaxError ? new Error("The words file is not valid JSON.") : error;
    }
    const minMatch = numberOption(values, "min-match", { min: 0, max: 1, fallback: 0.6 });
    const { captions, stats } = alignScriptToWords(job.script, words, { emphasis: job.emphasis });
    if (stats.matchRatio < minMatch) {
      throw new Error("Only " + Math.round(stats.matchRatio * 100) + "% of the approved script words were heard as written (need " + Math.round(minMatch * 100) + "%). Check that the words file comes from this piece's mastered voice.");
    }
    outputDirectory(p.runDir);
    assertNew([p.captions, p.captionsReport]);
    writeJson(p.captions, captions);
    writeJson(p.captionsReport, { alignedAt: new Date().toISOString(), consentId: consent.id, ...stats });
    log("Captions: " + stats.scriptWords + " script words; " + stats.equal + " matched, " + stats.replaced + " respread, " + stats.missed + " squeezed in, " + stats.extraHeard + " extra heard. Review them against the audio before rendering.");
  },

  async looks({ values, root, log, today }) {
    if (values.batch === undefined) throw new Error("Pass --batch with the ordered piece names, separated by commas.");
    const pieces = values.batch.split(",").map((piece) => slugSchema.parse(piece.trim()));
    const config = loadConfig({ root });
    const previous = values.previous ?? loadState({ root })?.lastLook ?? null;
    const plan = assignLooks(pieces, Object.keys(config.looks), { previous });
    log("Look rotation" + (previous ? " (previous batch ended on " + previous + ")" : "") + ":");
    for (const { piece, look } of plan) log("  " + piece + "  ->  " + look + " (" + config.looks[look].orientation + ")");
    if (values["save-state"]) {
      saveState({ schema: "clone-state/1", lastLook: plan[plan.length - 1].look, updatedOn: today }, { root });
      log("Saved the last look name to the ignored state file.");
    }
    return plan;
  },

  async props({ job, p, log, slug }) {
    const sync = readReport(p.syncReport, syncReportSchema, "Run the sync step first.");
    const captions = readReport(p.captions, alignedCaptionsSchema, "Run the captions step first.");
    for (const clip of job.broll) {
      if (!existsSync(join(ROOT, "public", clip.src))) throw new Error("B-roll file public/" + clip.src + " was not found.");
    }
    const props = buildSplicedShortProps({ src: sync.src, durationSec: sync.output.durationSec, captions, job });
    outputDirectory("brand-props");
    assertNew([p.props]);
    writeJson(p.props, props);
    log("Wrote brand-props/clone-" + slug + ".json for the SplicedShort composition (" + props.captions.length + " captions, " + props.cutaways.length + " B-roll clips, " + props.kickers.length + " kickers).");
    log("Render locally once SplicedShort is registered: npx remotion render src/index.tsx SplicedShort out/clone-" + slug + ".mp4 --props=brand-props/clone-" + slug + ".json");
    return props;
  },
};

main(import.meta.url, (args) => runClone(args));
