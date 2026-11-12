// Assemble one short from word-tight ranges of several takes, and keep a single
// source-to-output ledger so captions and cues can never drift from the picture.
//
// The input is what an editor actually decides: "from take B, keep 12.40s to 15.85s".
// The output is what the SplicedShort composition plays: frame-aligned source ranges,
// each segment's output start frame, and every surviving word retimed into output time.
//
// Rules this module enforces:
//   - Ranges snap to the composition's frame grid once, here. Everything downstream
//     (captions, punch-ins, cutaways) is derived from the snapped frames, not the raw ms.
//   - A word survives a cut only when its midpoint falls inside the kept range, so a
//     half-cut word never shows up as a caption for audio that is not there.
//   - Output time advances at 1x. A segment is never stretched to fit.
//
// Pure functions, no I/O. Tested by tests/splice-plan.test.mjs.

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** Lowercase, strip surrounding punctuation: "Done." and "done" are the same spoken word. */
const normalizeWord = (word) => word.toLowerCase().replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "");

/**
 * @typedef {{ word: string, startMs: number, endMs: number, segment?: number }} Word
 * @typedef {{ src: string, words?: Word[] }} Take
 * @typedef {{ take: string, inMs: number, outMs: number } & Record<string, unknown>} SegmentInput
 * @typedef {{ take: string, src: string, fromFrame: number, toFrame: number, outFrom: number,
 *             durationInFrames: number } & Record<string, unknown>} PlannedSegment
 */

/**
 * @param {{ fps: number, takes: Record<string, Take>, segments: SegmentInput[] }} input
 * @returns {{ fps: number, durationInFrames: number, segments: PlannedSegment[], captions: Word[] }}
 *   Each caption carries `segment`, the index of the segment it was kept from.
 */
export function buildSplicePlan({ fps, takes, segments }) {
  if (!Number.isInteger(fps) || fps <= 0) throw new Error(`fps must be a positive integer, got ${fps}`);
  if (!takes || typeof takes !== "object") throw new Error("takes must be an object keyed by take id");
  if (!Array.isArray(segments) || segments.length === 0) throw new Error("segments must be a non-empty array");

  const planned = [];
  const captions = [];
  let outFrom = 0;

  segments.forEach((segment, index) => {
    const where = `segments[${index}]`;
    const take = takes[segment.take];
    if (!take) throw new Error(`${where}: unknown take "${segment.take}"`);
    if (typeof take.src !== "string" || take.src.length === 0) {
      throw new Error(`${where}: take "${segment.take}" has no src`);
    }
    if (!isFiniteNumber(segment.inMs) || !isFiniteNumber(segment.outMs)) {
      throw new Error(`${where}: inMs and outMs must be finite numbers`);
    }
    if (segment.inMs < 0) throw new Error(`${where}: inMs must be >= 0, got ${segment.inMs}`);

    const fromFrame = Math.round((segment.inMs * fps) / 1000);
    const toFrame = Math.round((segment.outMs * fps) / 1000);
    if (toFrame <= fromFrame) {
      throw new Error(`${where}: range ${segment.inMs}-${segment.outMs}ms is empty on the ${fps} fps grid`);
    }

    const durationInFrames = toFrame - fromFrame;
    const { take: takeId, inMs: _in, outMs: _out, ...extra } = segment;
    planned.push({ ...extra, take: takeId, src: take.src, fromFrame, toFrame, outFrom, durationInFrames });

    // Retime the words that are audibly inside this range.
    const srcStartMs = (fromFrame * 1000) / fps;
    const srcEndMs = (toFrame * 1000) / fps;
    const outStartMs = (outFrom * 1000) / fps;
    const outEndMs = ((outFrom + durationInFrames) * 1000) / fps;
    for (const word of take.words ?? []) {
      const mid = (word.startMs + word.endMs) / 2;
      // Written as a positive test so a NaN timing is dropped instead of becoming a NaN caption.
      if (!(mid >= srcStartMs && mid < srcEndMs)) continue;
      const startMs = Math.max(outStartMs, outStartMs + (word.startMs - srcStartMs));
      const endMs = Math.min(outEndMs, outStartMs + (word.endMs - srcStartMs));
      captions.push({
        ...word,
        startMs: Math.round(startMs),
        endMs: Math.round(Math.max(startMs, endMs)),
        segment: index,
      });
    }

    outFrom += durationInFrames;
  });

  return { fps, durationInFrames: outFrom, segments: planned, captions };
}

/**
 * Map a source timestamp inside one planned segment to output milliseconds. Throws when
 * the moment was cut, so a cue can never be placed against audio that is not in the edit.
 *
 * @param {{ fps: number, segments: PlannedSegment[] }} plan
 * @param {number} index segment index
 * @param {number} sourceMs timestamp in that segment's take
 */
export function toOutputMs(plan, index, sourceMs) {
  const segment = plan.segments[index];
  if (!segment) throw new Error(`no segment ${index}`);
  const srcStartMs = (segment.fromFrame * 1000) / plan.fps;
  const srcEndMs = (segment.toFrame * 1000) / plan.fps;
  if (!isFiniteNumber(sourceMs) || sourceMs < srcStartMs || sourceMs > srcEndMs) {
    throw new Error(
      `segment ${index}: ${sourceMs}ms is outside the kept range ${Math.round(srcStartMs)}-${Math.round(srcEndMs)}ms`
    );
  }
  return Math.round((segment.outFrom * 1000) / plan.fps + (sourceMs - srcStartMs));
}

/**
 * Output start time of the nth (1-based) occurrence of a spoken word inside one segment.
 * Lets cues be written against the script ("pop on 'launch'") instead of raw timestamps.
 *
 * @param {{ fps: number, segments: PlannedSegment[], captions: Word[] }} plan
 * @param {number} index segment index
 * @param {string} text word to find; case and surrounding punctuation are ignored
 * @param {number} [nth]
 */
export function wordAt(plan, index, text, nth = 1) {
  const segment = plan.segments[index];
  if (!segment) throw new Error(`no segment ${index}`);
  const target = normalizeWord(text);
  // Match on the segment a caption came from, not on its rounded output time: a segment
  // that starts at a fractional millisecond would otherwise lose its first word.
  const hits = plan.captions.filter((w) => w.segment === index && normalizeWord(w.word) === target);
  const hit = hits[nth - 1];
  if (!hit) throw new Error(`segment ${index}: "${text}" occurrence ${nth} not found (found ${hits.length})`);
  return hit;
}
