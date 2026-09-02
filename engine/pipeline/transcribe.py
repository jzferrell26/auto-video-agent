"""Word-level timings from an audio file via faster-whisper (free, local, CPU).
Writes a captions JSON: [{ "word", "startMs", "endMs" }, ...].

Usage: python engine/pipeline/transcribe.py <audio.wav> <out.json>
"""
import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    audio = sys.argv[1] if len(sys.argv) > 1 else "public/brand-audio/short.wav"
    out = sys.argv[2] if len(sys.argv) > 2 else "brand-props/captions.json"

    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio, beam_size=5, word_timestamps=True)

    words = []
    for seg in segments:
        for w in seg.words or []:
            token = w.word.strip()
            if not token:
                continue
            words.append(
                {
                    "word": token,
                    "startMs": round(w.start * 1000),
                    "endMs": round(w.end * 1000),
                }
            )

    with open(out, "w", encoding="utf-8") as fh:
        json.dump(words, fh, indent=2)

    print(f"wrote {len(words)} words to {out}")
    if words:
        print(f"span: {words[0]['startMs']}ms -> {words[-1]['endMs']}ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
