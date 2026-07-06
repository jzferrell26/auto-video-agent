"""Full-session transcription for the course builder (free, local, CPU).
Outputs three artifacts next to the audio/video:
  <base>.segments.json : [{ "start","end","text" }]  (sentence-ish, for lesson segmentation)
  <base>.words.json    : [{ "word","startMs","endMs" }] (for burned-in captions)
  <base>.transcript.txt: human-readable "[mm:ss] text" for proposing the lesson map

Usage: python scripts/transcribe_full.py <audio-or-video> [model]
faster-whisper reads media directly (ffmpeg under the hood), so a raw .mp4 works.
"""
import json
import os
import sys

from faster_whisper import WhisperModel


def ts(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


def main() -> int:
    media = sys.argv[1] if len(sys.argv) > 1 else "_sources/session.mp4"
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"
    base = os.path.splitext(media)[0]

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    # vad_filter trims long silences: faster + cleaner boundaries on real recordings.
    segments, info = model.transcribe(
        media, beam_size=5, word_timestamps=True, vad_filter=True
    )

    seg_out, word_out, lines = [], [], []
    for seg in segments:
        text = seg.text.strip()
        seg_out.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
        lines.append(f"[{ts(seg.start)}] {text}")
        for w in seg.words or []:
            tok = w.word.strip()
            if tok:
                word_out.append({"word": tok, "startMs": round(w.start * 1000), "endMs": round(w.end * 1000)})

    with open(f"{base}.segments.json", "w", encoding="utf-8") as fh:
        json.dump(seg_out, fh, indent=2)
    with open(f"{base}.words.json", "w", encoding="utf-8") as fh:
        json.dump(word_out, fh, indent=2)
    with open(f"{base}.transcript.txt", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    total = seg_out[-1]["end"] if seg_out else 0
    print(f"segments: {len(seg_out)} | words: {len(word_out)} | duration: {ts(total)}")
    print(f"wrote {base}.segments.json / .words.json / .transcript.txt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
