// Captions from the APPROVED script words, timed from a whisper word list
// ([{ word, startMs, endMs }], the shape engine/pipeline/transcribe_full.py writes).
import { normalizeWord } from "./common.mjs";

/**
 * Whisper sometimes splits one written token into two: "high -level", "10 ,000", "example .com".
 * A token that starts with - . , or / followed by more text joins the previous token.
 */
export function mergeWhisperTokens(words) {
  const out = [];
  for (const word of words) {
    const text = String(word.word).trim();
    if (out.length && /^[-.,/]\S/.test(text)) {
      const last = out[out.length - 1];
      last.word += text;
      last.endMs = Math.max(last.endMs, word.endMs);
    } else {
      out.push({ word: text, startMs: word.startMs, endMs: word.endMs });
    }
  }
  return out;
}

/**
 * A port of Python difflib.SequenceMatcher with no junk heuristics (autojunk=False),
 * enough for get_matching_blocks and get_opcodes on two arrays of strings.
 */
export class SequenceMatcher {
  constructor(a, b) {
    this.a = a;
    this.b = b;
    this.b2j = new Map();
    b.forEach((item, j) => {
      if (!this.b2j.has(item)) this.b2j.set(item, []);
      this.b2j.get(item).push(j);
    });
  }

  findLongestMatch(alo, ahi, blo, bhi) {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks() {
    const queue = [[0, this.a.length, 0, this.b.length]];
    const blocks = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const merged = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) merged.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([this.a.length, this.b.length, 0]);
    return merged;
  }

  getOpcodes() {
    let i = 0;
    let j = 0;
    const codes = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) codes.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) codes.push(["equal", ai, i, bj, j]);
    }
    return codes;
  }
}

/**
 * Times every approved script word. Equal runs copy whisper's times; replaced runs spread
 * whisper's span linearly; script words whisper missed are spread between their neighbours.
 */
export function alignScriptToWords(script, whisperWords, { emphasis = [] } = {}) {
  const scriptWords = String(script).split(/\s+/).filter(Boolean);
  if (!scriptWords.length) throw new Error("The approved script is empty.");
  const heard = mergeWhisperTokens(whisperWords);
  if (!heard.length) throw new Error("The whisper word list is empty.");
  const matcher = new SequenceMatcher(scriptWords.map(normalizeWord), heard.map((word) => normalizeWord(word.word)));
  const times = new Array(scriptWords.length).fill(null);
  const stats = { equal: 0, replaced: 0, missed: 0, extraHeard: 0 };
  for (const [tag, i1, i2, j1, j2] of matcher.getOpcodes()) {
    if (tag === "equal") {
      for (let d = 0; d < i2 - i1; d += 1) times[i1 + d] = [heard[j1 + d].startMs, heard[j1 + d].endMs];
      stats.equal += i2 - i1;
    } else if (tag === "replace") {
      const start = heard[j1].startMs;
      const end = Math.max(start, heard[j2 - 1].endMs);
      const count = i2 - i1;
      for (let d = 0; d < count; d += 1) {
        times[i1 + d] = [Math.round(start + ((end - start) * d) / count), Math.round(start + ((end - start) * (d + 1)) / count)];
      }
      stats.replaced += count;
    } else if (tag === "delete") {
      stats.missed += i2 - i1;
    } else {
      stats.extraHeard += j2 - j1;
    }
  }
  for (let i = 0; i < times.length; i += 1) {
    if (times[i]) continue;
    let runEnd = i;
    while (runEnd < times.length && !times[runEnd]) runEnd += 1;
    const prev = i > 0 ? times[i - 1][1] : 0;
    const next = runEnd < times.length ? times[runEnd][0] : prev + 300 * (runEnd - i);
    const count = runEnd - i;
    const span = Math.max(count, next - prev);
    for (let d = 0; d < count; d += 1) {
      const start = Math.round(prev + (span * d) / count);
      times[i + d] = [start, Math.max(start + 1, Math.round(prev + (span * (d + 1)) / count))];
    }
    i = runEnd - 1;
  }
  const emphasized = new Set(emphasis.map(normalizeWord).filter(Boolean));
  const captions = scriptWords.map((word, index) => ({
    word,
    startMs: times[index][0],
    endMs: Math.max(times[index][0], times[index][1]),
    ...(emphasized.has(normalizeWord(word)) ? { emphasis: true } : {}),
  }));
  for (let i = 1; i < captions.length; i += 1) {
    if (captions[i].startMs < captions[i - 1].startMs) captions[i].startMs = captions[i - 1].startMs;
    if (captions[i].endMs < captions[i].startMs) captions[i].endMs = captions[i].startMs;
  }
  return { captions, stats: { ...stats, matchRatio: Number((stats.equal / scriptWords.length).toFixed(3)), scriptWords: scriptWords.length } };
}
