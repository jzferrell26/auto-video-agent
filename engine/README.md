# Engine reference

The root project registers all six components in `src/Root.tsx`. No separate host
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
| `npm run docs` / `npm run docs:check` | Regenerate / verify the composition tables below |
| `npm run render:job -- --composition <id> --props <file>` | One validated render, result stays in `out/` |
| `npm run master:audio -- --video <mp4> [--bed <audio>]` | Loudness master of a rendered video |
| `npm run pii:scan -- --video <mp4>` | Fail-closed PII gate for a transcript or video |
| `npm run redact -- --video <mp4> --regions <json>` | Blur named rectangles, optionally verified |
| `npm run archive -- --project <name> <files>` | Move finished videos to a synced folder |
| `npm run build` | Bundle for local build verification, not deployment |

Slugs contain 1-64 letters, digits, hyphens or underscores and must begin with a letter
or digit. Local CLI commands validate JSON and refuse existing outputs. A failed run
may leave partial files; inspect them before deliberately removing or retrying.

## Compositions

<!-- BEGIN GENERATED: compositions (engine/pipeline/gen-docs.mjs) -->
<!-- Do not edit by hand. Source: engine/compositions.mjs. Regenerate with npm run docs. -->

| ID | Renders | Output |
|---|---|---|
| `BrandedShort` | Video | Animated text short from a brief (9:16, 1:1 or 16:9) |
| `CourseCover` | Still image | Still course cover image |
| `LessonVideo` | Video | Lesson: intro card, footage with burned-in captions, outro card |
| `MicroClip` | Video | Vertical clip: footage in a framed 9:16 layout with large captions |
| `CaptionedShort` | Video | Caption-first short: your voiceover audio with burned-in word captions |
| `SplicedShort` | Video | 9:16 short spliced from several takes: reframe, punch-ins, captions, cutaway scenes |

<details>
<summary>Full prop reference (validated before every render)</summary>

#### `BrandedShort`

Animated text short from a brief (9:16, 1:1 or 16:9)

| Prop | Type | Required | Constraint |
|---|---|---|---|
| `theme` | { cream, slate, teal, gold, sage } | no | none |
| `logo` | string | no | none |
| `scenes` | { type, seconds }[] | yes | >= 1 item(s) |
| `width` | integer | no | >= 16 |
| `height` | integer | no | >= 16 |

#### `CourseCover`

Still course cover image

| Prop | Type | Required | Constraint |
|---|---|---|---|
| `theme` | { cream, slate, teal, gold, sage } | no | none |
| `logo` | string | no | none |
| `eyebrow` | string | no | none |
| `title` | string | yes | none |
| `subtitle` | string | no | none |

#### `LessonVideo`

Lesson: intro card, footage with burned-in captions, outro card

| Prop | Type | Required | Constraint |
|---|---|---|---|
| `theme` | { cream, slate, teal, gold, sage } | no | none |
| `logo` | string | no | none |
| `moduleTitle` | string | yes | none |
| `lessonNumber` | integer | yes | >= 1 |
| `lessonTitle` | string | yes | none |
| `videoSrc` | string | yes | none |
| `captions` | { word, startMs, endMs }[] | yes | none |
| `clipSeconds` | number | yes | > 0 |
| `introSeconds` | number | no | >= 0 |
| `outroSeconds` | number | no | >= 0 |
| `outroEyebrow` | string | no | none |
| `outroTitle` | string | no | none |
| `wordsPerPage` | integer | no | >= 1 |
| `width` | integer | no | >= 16 |
| `height` | integer | no | >= 16 |

#### `MicroClip`

Vertical clip: footage in a framed 9:16 layout with large captions

| Prop | Type | Required | Constraint |
|---|---|---|---|
| `theme` | { cream, slate, teal, gold, sage } | no | none |
| `logo` | string | no | none |
| `hook` | string | no | none |
| `videoSrc` | string | yes | none |
| `captions` | { word, startMs, endMs }[] | yes | none |
| `clipSeconds` | number | yes | > 0 |
| `wordsPerPage` | integer | no | >= 1 |
| `width` | integer | no | >= 16 |
| `height` | integer | no | >= 16 |

#### `CaptionedShort`

Caption-first short: your voiceover audio with burned-in word captions

| Prop | Type | Required | Constraint |
|---|---|---|---|
| `theme` | { cream, slate, teal, gold, sage } | no | none |
| `logo` | string | no | none |
| `eyebrow` | string | no | none |
| `audio` | string | yes | none |
| `captions` | { word, startMs, endMs }[] | yes | none |
| `wordsPerPage` | integer | no | >= 1 |
| `width` | integer | no | >= 16 |
| `height` | integer | no | >= 16 |

#### `SplicedShort`

9:16 short spliced from several takes: reframe, punch-ins, captions, cutaway scenes

| Prop | Type | Required | Constraint |
|---|---|---|---|
| `theme` | { background, surface, foreground, accent, muted, success, fontFamily, displayFontFamily } | no | none |
| `segments` | { src, fromFrame, toFrame, centerX, zoom, volume }[] | yes | >= 1 item(s) |
| `sourceWidth` | integer | no | >= 16 |
| `sourceHeight` | integer | no | >= 16 |
| `baseZoom` | number | no | > 0 |
| `baseOriginY` | number | no | >= 0, <= 1 |
| `drift` | number | no | >= 0, <= 0.5 |
| `punchIns` | { atMs, durMs, scale, ramp, anchorX, anchorY, whoosh }[] | no | none |
| `captions` | { word, startMs, endMs, emphasis }[] | no | none |
| `captionY` | number | no | >= 0 |
| `wordsPerPage` | integer | no | >= 1 |
| `cutaways` | { type, atMs, durMs, whoosh, captionY, hideCaptions }[] | no | none |
| `kickers` | { atMs, durMs, text, y, rotate }[] | no | none |
| `nameTag` | { name, title, atMs, durMs } | no | none |
| `sfx` | { src, atMs, volume }[] | no | none |
| `whooshSrc` | string | no | none |
| `whooshVolume` | number | no | >= 0, <= 1 |
| `tailMs` | number | no | >= 0, <= 60000 |
| `safeArea` | { top, bottom } | no | none |
| `width` | integer | no | >= 16 |
| `height` | integer | no | >= 16 |

</details>
<!-- END GENERATED: compositions -->

BrandedShort and CourseCover work without media. Run `npm run demo:media` once
before opening the other four default examples in Studio. Those defaults use the
synthetic files under `public/demo/`.

```bash
npx remotion still src/index.tsx CourseCover out/course-cover.png --frame=40
```

Direct Remotion commands are lower-level tools and can overwrite their explicit
output path; choose a new filename. The overwrite protection described above belongs
to this project's Node wrappers.

## Finishing tools

These work on files already inside the repository, never overwrite an output, and call
external programs with argument arrays. FFmpeg and ffprobe must be on your PATH.

**Audio master.** `master:audio` rebuilds only the audio of a rendered MP4 and copies the
video. It trims the AAC start delay that Remotion renders carry (2048 samples) so the voice
sits on the picture, optionally mixes a music bed (`--bed`, looped to length, about -28 LUFS,
dipped around 1 kHz and 2.5 kHz, faded, and ducked under the voice), then runs a two-pass
loudnorm to -14 LUFS integrated, -1.5 dBTP and LRA 11. It encodes AAC 256k, measures the
result with ebur128, and applies a limiter and measures again only if the true peak is above
-1.0 dBTP. It prints the final loudness and peak. It needs FFmpeg 7.1 or newer. You must have
the right to use any bed you supply, and you should still listen to the result.

**Privacy gate.** `pii:scan` looks for emails, phone numbers, SSNs, card numbers, IP addresses
and street addresses in a transcript and in sampled video frames, and fails closed: exit 1 if
it finds something, exit 2 if it could not verify. Reading on-screen text needs the optional
OCR engine, which is not a dependency of this repository: `npm install --no-save tesseract.js`.
It may download language data on first use. Without it, a frame scan stops with exit 2 rather
than reporting a false "clean". It cannot detect people's names, so skim the footage yourself.
`redact` blurs rectangles you list (`{ "label", "x", "y", "width", "height", "mode" }` in
source pixels) in one pass and can verify its own output with `--scan`.

**Archive.** `archive` copies finished videos into `VIDEO_ARCHIVE_DIR/<project>/` (set it in
your ignored `.env` to a cloud-synced folder, for example a Google Drive for desktop folder),
and removes the local file only after the copy matches by SHA-256. A sync client uploads in the
background, so confirm the files arrived before clearing its cache.

**Intermediate encoder.** `build:lessons` cuts each lesson with the first H.264 encoder that
passes a trial encode on your machine (hardware if it works, otherwise libx264) at a
near-lossless setting, because Remotion compresses the final file from that clip.

## Advanced: render job and remote storage

`render:job` renders one composition from a props file, checks the props against the
registry first, and leaves the result in `out/`. Everything that moves files is opt-in:

- `--source <uri>` downloads media into `public/` before rendering.
- `--out file:///...` copies the result somewhere inside the repository.
- `--out s3://`, `r2://` or `drive://` uploads to an external service. It is refused unless
  you also pass `--publish`, after you have reviewed the file in `out/` and approve that exact
  destination. These paths run the AWS CLI or rclone with your own credentials in the
  environment; see the header of `engine/pipeline/storage.mjs`. Existing remote objects follow
  that provider's overwrite behaviour, so use a new `--tag` for every version.

## Splicing a short

`SplicedShort` plays frame ranges of one or more takes end to end. Build the ranges with
`buildSplicePlan` from `engine/pipeline/splice-plan.mjs`: it snaps your in and out points to
the frame grid, keeps only the words that survive each cut, and retimes them into output time,
so captions and cues cannot drift from the picture. `whooshSrc` and `sfx` are optional; without
them the short is silent apart from the footage audio. `safeArea` is optional and has no preset.

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

`npm run check` runs strict TypeScript checking, the generated-docs check, tests, and
tracked-file/link hygiene. Add a composition to `engine/compositions.mjs`, then run `npm run docs`
instead of editing the generated tables by hand.
The React source uses Remotion's bundler resolution; Node scripts use native ESM with
explicit `.mjs` imports. This is a source template, not a published npm package.

See [the root README](../README.md) and [optional delivery](../docs/ghl-delivery.md).
