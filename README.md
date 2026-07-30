# auto-video-agent

Turn a long recording into **branded, captioned course lessons and short social clips**, then
deliver them (optionally straight into a GoHighLevel membership as a draft course). Built for
developers and operators who want to repurpose webinars, talks, and Zoom recordings at scale.

## Repository status

**Superseded prototype.** The active continuation is
[`jzferrell26/ai-video`](https://github.com/jzferrell26/ai-video), which contains this
project's core files plus newer work. This repository remains available as the original,
focused implementation of the video-processing engine.

> **Licensing, read first.** This project's code is **MIT**. It renders on **Remotion**, which
> is *source-available, not MIT*: free for individuals, non-profits, and companies of 3 or fewer
> employees (and non-commercial evaluation), but a **paid Company License is required for companies
> with more than 3 employees using it commercially**. See [`NOTICE.md`](NOTICE.md) and
> https://www.remotion.dev/docs/license. A Revideo (MIT) render path is a planned follow-up.

## What it does

```
long video
  -> transcribe (faster-whisper: word + segment timestamps)
  -> segment into a lesson map (titles + timecodes; author by hand or from the transcript)
  -> clip each lesson (ffmpeg, frame-accurate)
  -> brand each: intro card + burned-in captions + outro (Remotion) -> MP4
  -> export MP4s + a manifest   (and/or deliver: GoHighLevel course import)
```

It also renders **generative branded shorts** from a brief and **9:16 micro clips** from
highlight moments of the same source. Brand (colors, fonts, logo) is an input, not hardcoded.

## Components (`engine/remotion`)

| Composition | Output |
|---|---|
| `LessonVideo` | Course lesson: branded intro + real footage with burned-in captions + outro |
| `MicroClip` | 9:16 social clip: footage in a branded vertical frame with captions |
| `CourseCover` | Static branded course cover image |
| `BrandedShort` | Generative branded short from a brief (per-platform 9:16 / 1:1 / 16:9) |
| `CaptionedShort` | Caption-first: VO + burned-in word-level captions |

## Pipeline (`engine/pipeline`)

| Script | Does |
|---|---|
| `transcribe_full.py` | Full-session transcript: segments + words + readable text |
| `transcribe.py` | Word-level caption timings from audio |
| `build-lessons.mjs` | Lesson map -> clipped, branded, captioned lesson MP4s |
| `ghl-publish-complete.mjs` | Upload media + import a complete draft course to GoHighLevel |
| `render-platforms.mjs` | One brief -> per-platform renders (9:16 / 1:1 / 16:9) |

## Prerequisites

- Node 22+, Python 3.11+, FFmpeg on PATH
- `pip install faster-whisper`
- A Remotion host project (a `package.json` with Remotion deps + a `src/index.tsx` registering
  the compositions). The components import only `remotion` + `@remotion/google-fonts`.

## Configuration

Nothing is hardcoded to an account or brand. See [`.env.example`](.env.example):

```
GHL_LOCATION_ID=      # your GoHighLevel sub-account id (delivery only)
GHL_PIT=              # a Private Integration Token with courses.write + medias.write
```

Brand (theme colors, fonts, logo) is passed per job via the lesson map / props. A neutral demo
brand ships in [`engine/examples`](engine/examples); real brands and content stay out of the repo.

## Delivery to GoHighLevel

Optional. See [`docs/ghl-delivery.md`](docs/ghl-delivery.md) for the verified API contracts
(Import Courses, Media Upload, scopes, `bucketVideoUrl`, size limits). Everything imports as
**draft**, nothing publishes automatically.

## Layout

```
engine/
  remotion/   render components (brand is an input)
  pipeline/   transcribe, build-lessons, publish, per-platform
  examples/   neutral demo brand + sample map (no client data)
docs/         engine choice, GHL delivery reference
```
