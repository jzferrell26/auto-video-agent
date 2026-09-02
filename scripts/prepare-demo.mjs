// Creates only synthetic media. Existing files are never replaced.
import { join } from "node:path";
import { assertNew, main, outputDirectory, run, writeJson } from "../engine/pipeline/runtime.mjs";

main(import.meta.url, () => {
  const directory = outputDirectory("public/demo");
  const video = join(directory, "source.mp4");
  const audio = join(directory, "audio.wav");
  const words = join(directory, "captions.json");
  assertNew([video, audio, words]);
  run("ffmpeg", ["-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", video]);
  run("ffmpeg", ["-nostdin", "-n", "-i", video, "-vn", "-c:a", "pcm_s16le", audio]);
  writeJson(words, [
    { word: "Synthetic", startMs: 0, endMs: 1000 }, { word: "demo", startMs: 1000, endMs: 2000 },
    { word: "captions", startMs: 2000, endMs: 3000 },
  ]);
  console.log("Created public/demo/source.mp4, audio.wav and captions.json. The audio is a test tone, not speech.");
});
