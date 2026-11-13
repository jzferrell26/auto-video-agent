// Pure framing helpers: 16:9 avatar looks prepared for a 9:16 Short, and B-roll crop checks.
import { num } from "./audio.mjs";

export const PORTRAIT = Object.freeze({ width: 1080, height: 1920 });
export const FACE_WINDOW = Object.freeze({ width: 1080, height: 1350 }); // 4:5, centered vertically
/** House guidance: full-width screen captures are unreadable on a phone; crop to about this width. */
export const CROP_WIDTH_GUIDE = Object.freeze({ min: 560, max: 640 });

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * A 4:5 window centered on the face (faceX is 0..1 across the source width) over a blurred,
 * dimmed 9:16 fill of the same shot. Widths are even and both crops stay inside the frame.
 */
export function landscapePrepPlan({ sourceWidth, sourceHeight, faceX }) {
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 16 || sourceHeight < 16) {
    throw new Error("Source dimensions must be whole pixels of at least 16.");
  }
  if (typeof faceX !== "number" || !(faceX >= 0 && faceX <= 1)) throw new Error("Face position must be a number from 0 (left edge) to 1 (right edge).");
  const height = sourceHeight - (sourceHeight % 2);
  const windowWidth = even((height * 4) / 5);
  const fillWidth = even((height * 9) / 16);
  if (windowWidth > sourceWidth) throw new Error("This source is not landscape enough for a 4:5 face window. Use it as a full-frame portrait take instead.");
  const placeAt = (width) => Math.max(0, Math.min(sourceWidth - width, Math.round(sourceWidth * faceX - width / 2)));
  return {
    sourceWidth, sourceHeight, faceX,
    window: { x: placeAt(windowWidth), y: 0, width: windowWidth, height },
    fill: { x: placeAt(fillWidth), y: 0, width: fillWidth, height },
    overlayY: (PORTRAIT.height - FACE_WINDOW.height) / 2,
  };
}

export function landscapePrepFilter(plan) {
  const { window, fill } = plan;
  return "[0:v]split[a][b];"
    + "[a]crop=" + fill.width + ":" + fill.height + ":" + fill.x + ":0,scale=" + PORTRAIT.width + ":" + PORTRAIT.height
    + ",setsar=1,boxblur=30:2,eq=brightness=-0.12:saturation=0.85[bg];"
    + "[b]crop=" + window.width + ":" + window.height + ":" + window.x + ":0,scale=" + FACE_WINDOW.width + ":" + FACE_WINDOW.height
    + ":flags=lanczos,setsar=1[fg];"
    + "[bg][fg]overlay=0:" + plan.overlayY + ",format=yuv420p[v]";
}

/** Re-encodes the framed video and muxes the mastered voice; length capped to the video. */
export function landscapePrepArgs(video, audio, output, plan, durationSec) {
  if (!(durationSec > 0)) throw new Error("Video duration must be positive.");
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", video, "-i", audio,
    "-filter_complex", landscapePrepFilter(plan), "-map", "[v]", "-map", "1:a:0",
    "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "320k", "-t", num(durationSec), "-movflags", "+faststart", output];
}

/** Media paths in props are relative to public/. No absolute paths, URLs or parent segments. */
export function publicMediaPath(src) {
  if (typeof src !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/.test(src) || src.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("Clip paths must be relative to public/, for example clone/practice/broll-1.mp4.");
  }
  return src;
}

/** Checks a clip cutaway's crop against its source and the readable-width guide. */
export function validateClipCrop({ crop, sourceWidth, sourceHeight }, widthRange = CROP_WIDTH_GUIDE) {
  const whole = (value) => Number.isInteger(value);
  if (![sourceWidth, sourceHeight].every((value) => whole(value) && value >= 16)) throw new Error("B-roll needs its source width and height in whole pixels.");
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(whole)) throw new Error("B-roll crop values must be whole pixels.");
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) throw new Error("B-roll crop must start inside the frame and have a size.");
  if (crop.x + crop.width > sourceWidth || crop.y + crop.height > sourceHeight) {
    throw new Error("B-roll crop " + crop.width + "x" + crop.height + " at " + crop.x + "," + crop.y + " runs outside the " + sourceWidth + "x" + sourceHeight + " source.");
  }
  if (crop.width < widthRange.min || crop.width > widthRange.max) {
    throw new Error("B-roll crop is " + crop.width + " px wide; keep it " + widthRange.min + "-" + widthRange.max + " px. Full-width screen captures are unreadable on a phone, so crop to the part that matters.");
  }
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}
