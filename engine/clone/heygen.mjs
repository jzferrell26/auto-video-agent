// HeyGen v3 API client for the clone module. Network code takes an injectable fetch so tests
// never touch the network. Endpoints, fields and limits were read on HeyGen's developer docs
// on 2026-11-12; each constant names its page. Items the docs do not settle are marked UNVERIFIED.
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { providerIdSchema } from "./common.mjs";

// Base URL and auth header: https://developers.heygen.com/docs/api-key
export const HEYGEN_API_BASE = "https://api.heygen.com";
export const API_KEY_HEADER = "X-Api-Key";

export const DOCS = {
  apiKey: "https://developers.heygen.com/docs/api-key",
  speech: "https://developers.heygen.com/reference/generate-model-speech",
  createUpload: "https://developers.heygen.com/reference/create-asset-upload",
  completeUpload: "https://developers.heygen.com/reference/complete-asset-upload",
  directUpload: "https://developers.heygen.com/docs/direct-upload",
  createVideo: "https://developers.heygen.com/reference/create-video",
  audioToVideo: "https://developers.heygen.com/audio-to-video",
  getVideo: "https://developers.heygen.com/reference/get-video",
  avatar6: "https://developers.heygen.com/docs/models/avatar-6",
  usageLimits: "https://developers.heygen.com/docs/usage-limits",
};

// POST /v3/models/audio/tts (DOCS.speech). Request stays open until the WAV is ready.
export const SPEECH_PATH = "/v3/models/audio/tts";
export const TTS_MODELS = ["heygen-voice-1", "heygen-voice-1-turbo", "heygen-voice-1-turbo-free"];
export const DEFAULT_TTS_MODEL = "heygen-voice-1"; // the docs' default; professional voices use it
export const SPEED_RANGE = { min: 0.75, max: 1.25 }; // applies to professional clones only
export const MAX_TTS_TEXT = 10000;
// POST /v3/assets/direct-uploads, PUT upload_url, POST /v3/assets/{asset_id}/complete (DOCS.directUpload).
export const CREATE_UPLOAD_PATH = "/v3/assets/direct-uploads";
export const completeUploadPath = (assetId) => "/v3/assets/" + encodeURIComponent(assetId) + "/complete";
export const UPLOAD_AUDIO_CONTENT_TYPE = "audio/wav";
// POST /v3/videos with type "avatar" and audio_asset_id (DOCS.createVideo, DOCS.audioToVideo).
export const CREATE_VIDEO_PATH = "/v3/videos";
export const getVideoPath = (videoId) => "/v3/videos/" + encodeURIComponent(videoId);
export const ASPECT_RATIOS = ["9:16", "16:9", "4:5", "5:4", "1:1"];
export const RESOLUTIONS = ["720p", "1080p", "4k"];
// avatar_iii, avatar_iv and avatar_v come from the create-video reference; Avatar IV is used when
// engine is omitted. heygen-avatar-6 and heygen-avatar-6-turbo come from the Avatar 6 page (DOCS.avatar6).
export const VIDEO_ENGINES = ["avatar_iii", "avatar_iv", "avatar_v", "heygen-avatar-6", "heygen-avatar-6-turbo"];
// GET /v3/videos/{video_id} statuses (DOCS.getVideo): pending, processing, completed, failed.
// The create response's initial status (for example "waiting") is outside that list, so any
// status other than completed or failed is treated as still running.
export const VIDEO_DONE = "completed";
export const VIDEO_FAILED = "failed";
// Limits (DOCS.audioToVideo, DOCS.usageLimits): audio_asset_id is "MP3 or WAV, max 32 MB";
// avatar audio input is at most 600 seconds. The stricter documented size is enforced.
export const MAX_LIPSYNC_AUDIO_BYTES = 32_000_000;
export const MAX_AVATAR_AUDIO_SECONDS = 600;
// 429 carries Retry-After; 502, 503 and 504 are documented as "safe to retry" (DOCS.speech).
export const RETRYABLE_STATUS = [429, 502, 503, 504];
// UNVERIFIED: the docs call audio_url "URL of the generated audio file" and video_url a
// "Presigned URL"; they do not say whether a download needs the API key. This client never
// sends the key to a download or upload host.
export const SEND_KEY_TO_DOWNLOADS = false;
// UNVERIFIED: how long audio_url and video_url stay valid is not documented. Download promptly.

// Error codes named on the pages above. Only these short tokens are ever shown to the user;
// provider messages and bodies are never printed.
const KNOWN_ERROR_CODES = new Set([
  "unauthorized", "invalid_parameter", "rate_limit_exceeded", "insufficient_credit", "usage_limit_reached",
  "plan_upgrade_required", "voice_not_ready", "voice_training_failed", "voice_expired", "resource_not_ready",
  "request_in_progress", "avatar_not_usable", "asset_not_found", "conflict", "service_unavailable",
  "voice_provider_error",
]);

const httpsUrl = z.string().refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, "Expected an HTTPS URL.");
const speechData = z.object({ audio_url: httpsUrl, duration: z.number().nonnegative() });
const createUploadData = z.object({
  asset_id: providerIdSchema,
  upload_url: httpsUrl,
  upload_headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(2048)),
  max_bytes: z.number().int().positive(),
});
const completeUploadData = z.object({ asset_id: providerIdSchema, mime_type: z.string(), size_bytes: z.number().int().nonnegative(), status: z.string() });
const createVideoData = z.object({ video_id: providerIdSchema, status: z.string() });
const videoData = z.object({
  id: providerIdSchema,
  status: z.string(),
  video_url: httpsUrl.nullable().optional(),
  duration: z.number().nullable().optional(),
  failure_code: z.string().nullable().optional(),
});

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));
const safeCode = (code) => (typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "");

async function errorCode(response) {
  try {
    const value = await response.json();
    const code = value && value.error && value.error.code;
    return KNOWN_ERROR_CODES.has(code) ? code : "";
  } catch { return ""; }
}

async function discard(response) {
  try { await response.arrayBuffer(); } catch { /* the body is not needed */ }
}

/** Provider errors can echo content or credentials, so only the status and a known code are shown. */
export async function checkedJson(response, schema, operation) {
  if (!response.ok) {
    const code = await errorCode(response);
    throw new Error(operation + " failed (HTTP " + response.status + (code ? ", " + code : "") + "). Details stay private; check your HeyGen dashboard.");
  }
  let value;
  try { value = await response.json(); } catch { throw new Error(operation + " returned non-JSON data."); }
  const result = z.object({ data: schema }).safeParse(value);
  if (!result.success) throw new Error(operation + " returned an unexpected response. Check your HeyGen dashboard before retrying.");
  return result.data.data;
}

export function retryDelayMs(response, attempt) {
  const header = Number(response.headers.get("retry-after"));
  const fallback = 2000 * 2 ** (attempt - 1);
  return Math.min(60000, Number.isFinite(header) && header > 0 ? header * 1000 : fallback);
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createHeyGenClient({ apiKey, fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now, maxAttempts = 3 } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("HEYGEN_API_KEY is not set. Put it in your environment or the ignored .env file.");
  }
  const key = apiKey.trim();

  async function api(operation, method, path, { body, idempotencyKey, timeoutMs = 60000, schema }) {
    const headers = { [API_KEY_HEADER]: key, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(HEYGEN_API_BASE + path, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new Error(operation + " could not reach HeyGen. Check your connection; nothing is retried automatically.");
      }
      if (RETRYABLE_STATUS.includes(response.status) && attempt < maxAttempts) {
        const delay = retryDelayMs(response, attempt);
        await discard(response);
        await sleep(delay);
        continue;
      }
      return checkedJson(response, schema, operation);
    }
  }

  const client = {
    /** POST /v3/models/audio/tts. Returns the generated audio URL and duration in seconds. */
    async generateSpeech({ voiceId, text, model = DEFAULT_TTS_MODEL, speed, language }) {
      providerIdSchema.parse(voiceId);
      if (!TTS_MODELS.includes(model)) throw new Error("Unknown speech model. Use one of: " + TTS_MODELS.join(", ") + ".");
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TTS_TEXT) throw new Error("Script text must be 1-" + MAX_TTS_TEXT + " characters.");
      if (typeof speed !== "number" || speed < SPEED_RANGE.min || speed > SPEED_RANGE.max) {
        throw new Error("Choose a speed from " + SPEED_RANGE.min + " to " + SPEED_RANGE.max + ", for example 1.1. It is always sent explicitly.");
      }
      const body = { voice_id: voiceId, text, model, speed };
      if (language) body.language = language;
      const data = await api("Speech generation", "POST", SPEECH_PATH, { body, timeoutMs: 600000, schema: speechData });
      return { audioUrl: data.audio_url, durationSec: data.duration };
    },

    /** Direct upload: create, PUT to the presigned URL (no API key), complete. */
    async uploadAudio(filePath, { idempotencyKey } = {}) {
      if (statSync(filePath).size > MAX_LIPSYNC_AUDIO_BYTES) throw new Error("The audio file is over 32 MB, the documented limit for lip-sync audio. Split the script into shorter pieces.");
      const bytes = readFileSync(filePath);
      if (!bytes.length) throw new Error("The audio file is empty.");
      if (bytes.length > MAX_LIPSYNC_AUDIO_BYTES) throw new Error("The audio file is over 32 MB, the documented limit for lip-sync audio. Split the script into shorter pieces.");
      const checksum = sha256Hex(bytes);
      const created = await api("Upload request", "POST", CREATE_UPLOAD_PATH, {
        body: { filename: basename(filePath), content_type: UPLOAD_AUDIO_CONTENT_TYPE, size_bytes: bytes.length, checksum_sha256: checksum },
        idempotencyKey, schema: createUploadData,
      });
      if (bytes.length > created.max_bytes) throw new Error("HeyGen reported a smaller upload limit than this file. Nothing was uploaded.");
      if (Object.keys(created.upload_headers).some((name) => name.toLowerCase() === API_KEY_HEADER.toLowerCase())) {
        throw new Error("Upload instructions were not as documented. Nothing was uploaded.");
      }
      let put;
      try {
        put = await fetchImpl(created.upload_url, {
          method: "PUT", headers: { ...created.upload_headers }, body: bytes,
          redirect: "error", signal: AbortSignal.timeout(600000),
        });
      } catch {
        throw new Error("Upload transfer could not reach storage. The presigned URL stays valid for 24 hours; retry the upload command.");
      }
      await discard(put);
      if (!put.ok) throw new Error("Upload transfer failed (HTTP " + put.status + "). Retry the upload command; HeyGen replays the same upload for 24 hours.");
      const done = await api("Upload completion", "POST", completeUploadPath(created.asset_id), {
        body: { checksum_sha256: checksum }, schema: completeUploadData,
      });
      if (done.asset_id !== created.asset_id || done.size_bytes !== bytes.length) {
        throw new Error("Upload completion returned a different asset or size. Check your HeyGen dashboard before retrying.");
      }
      return { assetId: done.asset_id, sizeBytes: done.size_bytes, mimeType: done.mime_type, checksum };
    },

    /** POST /v3/videos, type avatar, lip-synced to an uploaded audio asset. */
    async createAvatarVideo({ avatarId, audioAssetId, aspectRatio = "9:16", resolution = "1080p", engine, title, idempotencyKey }) {
      providerIdSchema.parse(avatarId);
      providerIdSchema.parse(audioAssetId);
      if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error("Unsupported aspect ratio.");
      if (!RESOLUTIONS.includes(resolution)) throw new Error("Unsupported resolution.");
      if (engine !== undefined && !VIDEO_ENGINES.includes(engine)) throw new Error("Unknown engine. Use one of: " + VIDEO_ENGINES.join(", ") + ".");
      const body = { type: "avatar", avatar_id: avatarId, audio_asset_id: audioAssetId, aspect_ratio: aspectRatio, resolution };
      if (engine) body.engine = { type: engine };
      if (title) body.title = title;
      const data = await api("Video creation", "POST", CREATE_VIDEO_PATH, { body, idempotencyKey, schema: createVideoData });
      return { videoId: data.video_id, status: data.status };
    },

    /** GET /v3/videos/{video_id}. */
    async getVideo(videoId) {
      providerIdSchema.parse(videoId);
      const data = await api("Video status", "GET", getVideoPath(videoId), { schema: videoData });
      return { videoId: data.id, status: safeCode(data.status) || "unknown", videoUrl: data.video_url ?? null, durationSec: data.duration ?? null, failureCode: safeCode(data.failure_code) };
    },

    /** Polls with growing delays until completed, failed, or the timeout passes. */
    async waitForVideo(videoId, { timeoutMs = 20 * 60000, firstDelayMs = 10000, maxDelayMs = 60000, factor = 1.5, onStatus } = {}) {
      const deadline = now() + timeoutMs;
      let delay = firstDelayMs;
      for (;;) {
        const video = await client.getVideo(videoId);
        if (onStatus) onStatus(video.status);
        if (video.status === VIDEO_DONE) {
          if (!video.videoUrl) throw new Error("HeyGen reported the video completed without a download URL. Check your dashboard.");
          return video;
        }
        if (video.status === VIDEO_FAILED) {
          throw new Error("HeyGen reported the video failed" + (video.failureCode ? " (" + video.failureCode + ")" : "") + ". Nothing is retried automatically; check your dashboard.");
        }
        if (now() + delay > deadline) {
          throw new Error("Timed out after " + Math.round(timeoutMs / 60000) + " min. The video may still finish: rerun the same lipsync command with --run to resume polling it without a new request.");
        }
        await sleep(delay);
        delay = Math.min(maxDelayMs, Math.round(delay * factor));
      }
    },
  };
  return client;
}

/** Streams a provider file to a new local path. Never sends the API key; refuses non-HTTPS URLs. */
export async function downloadToFile(url, dest, { fetchImpl = globalThis.fetch, maxBytes, timeoutMs = 600000, operation = "Download" } = {}) {
  const isHttps = (value) => { try { return new URL(value).protocol === "https:"; } catch { return false; } };
  if (!isHttps(url)) throw new Error(operation + " refused a non-HTTPS URL.");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error(operation + " needs a size limit.");
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(operation + " could not reach the file host. Retry soon; provider links can expire.");
  }
  if (!response.ok || !response.body) {
    await discard(response);
    throw new Error(operation + " failed (HTTP " + response.status + "). Provider links can expire; fetch a fresh status and retry.");
  }
  if (response.url && !isHttps(response.url)) throw new Error(operation + " was redirected to a non-HTTPS URL.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(operation + " is larger than the allowed size.");
  let fd;
  try { fd = openSync(dest, "wx"); } catch { throw new Error(operation + " target already exists or cannot be created. Choose a new slug."); }
  let written = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      callback(written > maxBytes ? new Error("too large") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(null, { fd }));
  } catch {
    try { closeSync(fd); } catch { /* the stream may already have closed it */ }
    rmSync(dest, { force: true });
    throw new Error(operation + " did not finish (interrupted or over the size limit). The partial file was removed.");
  }
  if (!written) {
    rmSync(dest, { force: true });
    throw new Error(operation + " returned an empty file.");
  }
  return written;
}
