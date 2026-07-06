# engine/

The original, license-clean core of auto-video-agent. Everything here is original work:
the brand-native render components and the pipeline scripts. It imports only Remotion and
`@remotion/google-fonts`, no OpenMontage / AGPL code. This is the reference implementation;
if we move engines (see [`../docs/engine-decision.md`](../docs/engine-decision.md)), the
component shapes and props contracts port directly.

> The disposable OpenMontage trial host, `node_modules`, downloaded client videos, transcripts,
> and rendered MP4s live in the gitignored `_experiments/` and are never committed. `engine/` is
> the canonical source; `_experiments/` is a throwaway runtime.

## remotion/ — brand-native scene components

| File | Composition | Output |
|---|---|---|
| `BrandedShort.tsx` | `BrandedShort` | Generative branded short from a brief (brand spec + scenes -> MP4). Per-platform via `width`/`height` props. |
| `CaptionedShort.tsx` | `CaptionedShort` | Caption-first: VO audio + burned-in word-level captions. |
| `LessonVideo.tsx` | `LessonVideo` | Course lesson: branded intro card + real footage (`OffthreadVideo`) + burned-in captions + outro. |
| `fonts.ts` | (shared) | Loads Cormorant Garamond + DM Sans via `@remotion/google-fonts`. |

Each component exports a `calculate*Metadata` that sets duration (and width/height) from props.
The **brand spec is the input**: pass `theme` (cream/slate/teal/gold/sage) + `logo` + content via
`--props`. To run, register the compositions in a Remotion `Root.tsx`, e.g.:

```tsx
import { BrandedShort, calculateBrandedShortMetadata } from "./remotion/BrandedShort";
<Composition id="BrandedShort" component={BrandedShort} fps={30} width={1080} height={1920}
  durationInFrames={30 * 27} defaultProps={{ scenes: [] }} calculateMetadata={calculateBrandedShortMetadata} />
```

> **Running:** `engine/` is the source of truth, not a standalone app. To run it, drop these
> files into a Remotion host project (a `package.json` with the Remotion deps + a `src/index.tsx`
> that registers the compositions). The `pipeline/` scripts resolve the Remotion CLI from that
> host's root and render from there. In development the host is the gitignored `_experiments/`
> trial; `engine/` is what we keep and port when the engine is chosen.

## pipeline/ — the free, local processing scripts

| File | Does |
|---|---|
| `transcribe.py` | Word-level timings from audio (faster-whisper) -> captions JSON. |
| `transcribe_full.py` | Full-session transcript: `.segments.json` + `.words.json` + readable `.transcript.txt` (for proposing a lesson map). |
| `render-platforms.mjs` | One brief -> per-platform renders (9:16 / 1:1 / 16:9). Single-sourced content, injects width/height. |

Course-builder flow (proven): source video -> `transcribe_full.py` -> propose lesson map from the
transcript -> `ffmpeg -ss/-to` frame-accurate clip per lesson -> `LessonVideo` (brand + captions) ->
course-ready MP4. Social shorts come off the same source via `BrandedShort` / clips.

## examples/

`demo-course.json` — a generic, PII-free lesson map (brand spec + placeholder content) that drives
`build-lessons.mjs` and `ghl-publish-complete.mjs`. Copy it and replace the theme, copy, and
timecodes with your own. Client-derived props (real transcripts/captions/audio) are never committed.
