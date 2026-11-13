// Pure audio helpers: FFmpeg filtergraph and argument builders, loudness parsing, and an
// FFT cross-correlation lag estimate. Nothing here starts a process; see media.mjs.

export const MASTER_DEFAULTS = Object.freeze({
  highpassHz: 80,
  dynamics: "compressor", // or "gate"
  compressorThresholdDb: -20,
  compressorRatio: 2.5,
  compressorAttackMs: 5,
  compressorReleaseMs: 100,
  gateThresholdDb: -36,
  gateRatio: 2,
  limit: 0.72, // alimiter ceiling as a linear sample level (about -2.9 dBFS)
  sampleRate: 48000,
  targetLufs: -14,
  lufsTolerance: 1,
  maxTruePeakDb: -1.5,
  checkBitrate: "320k",
});

export function dbToLinear(db) {
  return 10 ** (db / 20);
}

/** Fixed-point text for filter options, so no value is ever written in exponent form. */
export function num(value) {
  if (!Number.isFinite(value)) throw new Error("Filter values must be finite numbers.");
  return String(Number(value.toFixed(6)));
}

export function masterOptions(overrides = {}) {
  const options = { ...MASTER_DEFAULTS, ...overrides };
  if (!["compressor", "gate"].includes(options.dynamics)) throw new Error("Dynamics must be compressor or gate.");
  if (!(options.limit >= 0.0625 && options.limit <= 1)) throw new Error("Limiter ceiling must be between 0.0625 and 1.");
  if (!(options.highpassHz > 0 && options.highpassHz < 1000)) throw new Error("High-pass frequency must be between 0 and 1000 Hz.");
  if (!(options.targetLufs <= -5 && options.targetLufs >= -40)) throw new Error("Target loudness must be between -40 and -5 LUFS.");
  return options;
}

export function dynamicsFilter(options) {
  return options.dynamics === "gate"
    ? "agate=threshold=" + num(dbToLinear(options.gateThresholdDb)) + ":ratio=" + num(options.gateRatio) + ":attack=10:release=200"
    : "acompressor=threshold=" + num(dbToLinear(options.compressorThresholdDb)) + ":ratio=" + num(options.compressorRatio)
      + ":attack=" + num(options.compressorAttackMs) + ":release=" + num(options.compressorReleaseMs);
}

/** High-pass plus gate or compressor, before makeup gain. Used for the first loudness read. */
export function preGainFilter(options) {
  return "highpass=f=" + num(options.highpassHz) + "," + dynamicsFilter(options);
}

/** Full chain. level=0 matters: alimiter's auto level is on by default and would undo the ceiling. */
export function masterFilter(options, makeupDb) {
  return preGainFilter(options) + ",volume=" + num(makeupDb) + "dB,alimiter=limit=" + num(options.limit) + ":level=0";
}

export function measureArgs(input, filterPrefix = "") {
  return ["-hide_banner", "-nostdin", "-nostats", "-i", input, "-vn", "-af", (filterPrefix ? filterPrefix + "," : "") + "ebur128=peak=true", "-f", "null", "-"];
}

export function masterArgs(input, output, filter, sampleRate = MASTER_DEFAULTS.sampleRate) {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", input, "-vn", "-af", filter,
    "-ar", String(sampleRate), "-ac", "1", "-c:a", "pcm_s16le", output];
}

/** The loudness check runs on an AAC encode because that is what the platforms receive. */
export function aacCheckArgs(input, output, bitrate = MASTER_DEFAULTS.checkBitrate) {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", input, "-vn", "-c:a", "aac", "-b:a", bitrate, output];
}

const level = (text) => (/^-?inf$/i.test(text) ? -Infinity : Number(text));

/** Reads the last ebur128 summary (integrated loudness and true peak) from FFmpeg's log. */
export function parseLoudnessSummary(log) {
  const start = String(log).lastIndexOf("Summary:");
  const summary = start >= 0 ? String(log).slice(start) : "";
  const integrated = summary.match(/Integrated loudness:\s*\n\s*I:\s*(-?(?:[\d.]+|inf))\s*LUFS/i);
  const peak = summary.match(/True peak:\s*\n\s*Peak:\s*(-?(?:[\d.]+|inf))\s*dBFS/i);
  if (!integrated || !peak) throw new Error("Could not read the loudness summary. Use an FFmpeg build with the ebur128 filter.");
  return { integratedLufs: level(integrated[1]), truePeakDb: level(peak[1]) };
}

export function loudnessVerdict({ integratedLufs, truePeakDb }, options = MASTER_DEFAULTS) {
  const problems = [];
  if (!(Math.abs(integratedLufs - options.targetLufs) <= options.lufsTolerance)) {
    problems.push("integrated loudness " + integratedLufs + " LUFS is outside " + options.targetLufs + " +/- " + options.lufsTolerance + " LU");
  }
  if (!(truePeakDb < options.maxTruePeakDb)) problems.push("true peak " + truePeakDb + " dBTP is not under " + options.maxTruePeakDb + " dBTP");
  return { pass: problems.length === 0, problems };
}

/** Next makeup gain: aim the measured loudness at the target, within a sane range. */
export function makeupGainDb(measuredLufs, targetLufs) {
  if (!Number.isFinite(measuredLufs)) throw new Error("The audio is silent; there is nothing to master.");
  return Math.max(-20, Math.min(30, Number((targetLufs - measuredLufs).toFixed(2))));
}

/** Mono 16-bit PCM on stdout, for the lag estimate. */
export function pcmArgs(input, sampleRate = 16000, maxSeconds = 120) {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", input, "-vn", "-t", num(maxSeconds),
    "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "-"];
}

export function int16ToFloat(buffer) {
  const count = Math.floor(buffer.length / 2);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) out[i] = buffer.readInt16LE(i * 2) / 32768;
  return out;
}

/** In-place iterative radix-2 FFT. Length must be a power of two. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length || n & (n - 1)) throw new Error("FFT length must be a power of two.");
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Estimates how far `render` lags `master` by cross-correlation.
 * A positive lag means the render's audio arrives later than the mastered voice.
 * score is the normalized correlation at the peak (about 1 for the same audio).
 */
export function estimateLag(render, master, { sampleRate = 16000, maxLagMs = 1000 } = {}) {
  const n = Math.min(render.length, master.length);
  if (n < sampleRate / 2) throw new Error("Need at least half a second of audio in both files to check sync.");
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += render[i];
    meanB += master[i];
  }
  meanA /= n;
  meanB /= n;
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < n; i += 1) {
    aRe[i] = render[i] - meanA;
    bRe[i] = master[i] - meanB;
    energyA += aRe[i] * aRe[i];
    energyB += bRe[i] * bRe[i];
  }
  if (!energyA || !energyB) throw new Error("One of the audio tracks is silent; sync cannot be checked.");
  fft(aRe, aIm);
  fft(bRe, bIm);
  for (let k = 0; k < size; k += 1) {
    const re = aRe[k] * bRe[k] + aIm[k] * bIm[k];
    const im = aIm[k] * bRe[k] - aRe[k] * bIm[k];
    aRe[k] = re;
    aIm[k] = im;
  }
  fft(aRe, aIm, true);
  const window = Math.min(n - 1, Math.round((maxLagMs * sampleRate) / 1000));
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = -window; lag <= window; lag += 1) {
    const value = aRe[lag >= 0 ? lag : size + lag];
    if (value > best) {
      best = value;
      bestLag = lag;
    }
  }
  return {
    lagSamples: bestLag,
    lagMs: Number(((bestLag * 1000) / sampleRate).toFixed(2)),
    score: Number((best / Math.sqrt(energyA * energyB)).toFixed(4)),
    sampleRate,
  };
}

export function syncVerdict(lag, { maxLagMs = 0, minScore = 0.5 } = {}) {
  const problems = [];
  if (Math.abs(Math.round(lag.lagMs)) > maxLagMs) problems.push("audio is offset by " + lag.lagMs + " ms (allowed " + maxLagMs + " ms)");
  if (!(lag.score >= minScore)) problems.push("the render's audio does not match the mastered voice (match score " + lag.score + ", need " + minScore + ")");
  return { pass: problems.length === 0, problems };
}

/** Original video stream copied, mastered voice as AAC 320k, length capped to the video, faststart. */
export function remuxArgs(video, audio, output, durationSec) {
  if (!(durationSec > 0)) throw new Error("Video duration must be positive.");
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", video, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
    "-t", num(durationSec), "-movflags", "+faststart", output];
}
