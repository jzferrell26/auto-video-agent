# Engine reference

The root project registers all five components in `src/Root.tsx`. No separate host
project or private repository is required.

## Commands

Run from the repository root. Node pipeline scripts also resolve relative input paths
from the root, not from `engine/`.

| Command | Result |
|---|---|
| `npm run studio` | Local Remotion editor |
| `npm run compositions` | Registered composition metadata |
| `npm run demo` | New text-only demo render |
| `npm run demo:media` | Six-second synthetic video, audio and invented captions |
| `npm run render:platforms -- <brief.json> <slug>` | Three aspect-ratio renders |
| `npm run build:lessons -- <video> <words.json> <map.json> <slug>` | Clipped, captioned lessons |
| `npm run deliver:ghl -- <map.json> <slug>` | Local delivery preview, no network |
| `npm run build` | Bundle for local build verification, not deployment |

Slugs contain 1-64 letters, digits, hyphens or underscores and must begin with a letter
or digit. Local CLI commands validate JSON and refuse existing outputs. A failed run
may leave partial files; inspect them before deliberately removing or retrying.

## Compositions

| ID | Output | Main inputs |
|---|---|---|
| `BrandedShort` | Animated text short | `scenes`, optional theme/logo/width/height |
| `CourseCover` | Still cover | `title`, optional eyebrow/subtitle/theme/logo |
| `LessonVideo` | Intro, footage, captions, outro | Module/lesson titles, videoSrc, clipSeconds, captions |
| `MicroClip` | Vertical framed footage | videoSrc, clipSeconds, captions, optional hook |
| `CaptionedShort` | Caption-first voiceover | audio, captions, optional eyebrow |

BrandedShort and CourseCover work without media. Run `npm run demo:media` once
before opening the other three default examples in Studio. Those defaults use the
synthetic files under `public/demo/`.

```bash
npx remotion still src/index.tsx CourseCover out/course-cover.png --frame=40
```

Direct Remotion commands are lower-level tools and can overwrite their explicit
output path; choose a new filename. The overwrite protection described above belongs
to this project's Node wrappers.

## Input formats

A caption array uses milliseconds:

```json
[{ "word": "Example", "startMs": 0, "endMs": 500 }]
```

A lesson map uses seconds:

```json
{
  "module": "Practice",
  "lessons": [
    { "number": 1, "title": "First idea", "inSec": 0, "outSec": 3 }
  ]
}
```

Lesson end must follow start and stay within the source duration. Words starting in
the retained interval are rebased; tails are clipped at the lesson end. Review cuts
that may split spoken words.

Theme keys are `cream`, `slate`, `teal`, `gold`, and `sage`, each a CSS color.
The shared fonts are Cormorant Garamond and DM Sans. Font loading can require network
access. A logo is optional; no real brand assets are bundled.

Media paths in composition props are relative to `public/`, or explicit remote URLs.
Prefer local assets and never include credentials or signed URLs in committed props.
Only use trusted assets and configurations. These tools are not a secure hosted
rendering service for arbitrary submissions.

## Transcription

After installing the optional Python tools and adding your own input files, run:

```bash
python engine/pipeline/transcribe_full.py _sources/session.mp4 base.en
python engine/pipeline/transcribe.py _sources/voice.wav brand-props/captions.json
```

Create `brand-props/` before the second command. Full transcription writes
`.segments.json`, `.words.json`, and `.transcript.txt` beside the input. These outputs
are ignored. The existing Python scripts replace outputs with the same names, so
preserve any manually corrected transcripts before rerunning them.

The default model is English-only, CPU/int8. Full transcription accepts a different
faster-whisper model name as its second argument. Model downloads require internet
access and may take time. After download, speech processing runs locally.

## Development

`npm run check` runs strict TypeScript checking, tests, and tracked-file/link hygiene.
The React source uses Remotion's bundler resolution; Node scripts use native ESM with
explicit `.mjs` imports. This is a source template, not a published npm package.

See [the root README](../README.md) and [optional delivery](../docs/ghl-delivery.md).
