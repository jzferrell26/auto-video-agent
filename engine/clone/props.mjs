// Builds props for the SplicedShort composition from the synced clip, aligned captions and the
// job's kickers and B-roll. Pure data in, pure data out. The contract mirrors SplicedShort's
// prop types (segments, captions, clip cutaways, kickers); SplicedShort itself ships separately.
import { z } from "zod";
import { normalizeWord } from "./common.mjs";
import { CROP_WIDTH_GUIDE, publicMediaPath, validateClipCrop } from "./framing.mjs";

export const SPLICED_FPS = 30; // SplicedShort renders on a 30 fps grid

const caption = z.object({ word: z.string().min(1), startMs: z.number().min(0), endMs: z.number().min(0), emphasis: z.boolean().optional() }).strict();
const timing = { atMs: z.number().min(0), durMs: z.number().positive().max(600000) };

export const splicedShortPropsSchema = z.object({
  segments: z.array(z.object({
    src: z.string().min(1),
    fromFrame: z.number().int().min(0),
    toFrame: z.number().int().min(1),
    centerX: z.number().min(0).max(1).optional(),
    zoom: z.number().positive().optional(),
  }).strict()).min(1),
  captions: z.array(caption),
  cutaways: z.array(z.object({
    type: z.literal("clip"),
    ...timing,
    src: z.string().min(1),
    sourceFrom: z.number().int().min(0),
    crop: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    sourceWidth: z.number().int().min(16),
    sourceHeight: z.number().int().min(16),
    eyebrow: z.string().optional(),
    whoosh: z.boolean(),
  }).strict()),
  kickers: z.array(z.object({ ...timing, text: z.string().min(1) }).strict()),
  theme: z.record(z.string(), z.string()).optional(),
  captionY: z.number().min(0).optional(),
  wordsPerPage: z.number().int().min(1).optional(),
  tailMs: z.number().min(0).max(60000).optional(),
  safeArea: z.object({ top: z.number().optional(), bottom: z.number().optional() }).strict().optional(),
}).strict();

/** Index of the first caption where `phrase` starts, searching from `from`; -1 if absent. */
export function findPhrase(captions, phrase, from = 0) {
  const target = String(phrase).split(/\s+/).map(normalizeWord).filter(Boolean);
  if (!target.length) return -1;
  for (let i = Math.max(0, from); i + target.length <= captions.length; i += 1) {
    if (target.every((word, offset) => normalizeWord(captions[i + offset].word) === word)) return i;
  }
  return -1;
}

function phraseIndex(captions, phrase, from, label) {
  const index = findPhrase(captions, phrase, from);
  if (index < 0) throw new Error(label + " phrase \"" + phrase + "\" is not in the approved script captions.");
  return index;
}

export function buildSplicedShortProps({ src, durationSec, captions, job }) {
  publicMediaPath(src);
  if (!(durationSec > 0)) throw new Error("The synced clip needs a positive duration.");
  const toFrame = Math.floor(durationSec * SPLICED_FPS);
  if (toFrame < 1) throw new Error("The synced clip is shorter than one frame.");
  const endMs = Math.round((toFrame * 1000) / SPLICED_FPS);
  const kept = captions
    .filter((word) => word.startMs < endMs)
    .map((word) => ({ ...word, endMs: Math.min(word.endMs, endMs) }));

  const kickers = job.kickers.map((kicker) => {
    const atMs = kicker.atPhrase !== undefined ? kept[phraseIndex(kept, kicker.atPhrase, 0, "Kicker")].startMs : kicker.atMs;
    if (atMs >= endMs) throw new Error("Kicker \"" + kicker.text + "\" starts after the clip ends.");
    return { atMs, durMs: Math.min(kicker.durMs, endMs - atMs), text: kicker.text };
  });

  const widthRange = job.brollWidth ?? CROP_WIDTH_GUIDE;
  const cutaways = job.broll.map((clip, index) => {
    const label = "B-roll " + (index + 1);
    let atMs = clip.atMs;
    let durMs = clip.durMs;
    if (clip.fromPhrase !== undefined) {
      const first = phraseIndex(kept, clip.fromPhrase, 0, label + " start");
      const lastStart = phraseIndex(kept, clip.toPhrase, first, label + " end");
      const last = lastStart + String(clip.toPhrase).split(/\s+/).filter(Boolean).length - 1;
      atMs = Math.max(0, kept[first].startMs - clip.leadMs);
      durMs = Math.min(endMs, kept[last].endMs + clip.tailMs) - atMs;
    }
    if (!(durMs > 0) || atMs + durMs > endMs) throw new Error(label + " must start and end inside the clip.");
    const crop = validateClipCrop(clip, widthRange);
    return {
      type: "clip", atMs, durMs, src: publicMediaPath(clip.src), sourceFrom: clip.sourceFrom, crop,
      sourceWidth: clip.sourceWidth, sourceHeight: clip.sourceHeight,
      ...(clip.eyebrow ? { eyebrow: clip.eyebrow } : {}),
      whoosh: clip.whoosh,
    };
  }).sort((a, b) => a.atMs - b.atMs);
  for (let i = 1; i < cutaways.length; i += 1) {
    if (cutaways[i].atMs < cutaways[i - 1].atMs + cutaways[i - 1].durMs) throw new Error("B-roll clips overlap; space them out.");
  }

  return splicedShortPropsSchema.parse({
    segments: [{ src, fromFrame: 0, toFrame, centerX: job.centerX, zoom: job.zoom }],
    captions: kept,
    cutaways,
    kickers,
    ...job.spliced,
  });
}
