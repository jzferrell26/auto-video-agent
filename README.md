# auto-video-agent

Turn your recordings into captioned lessons and social clips with your own branding.

[![CI](https://github.com/jzferrell26/auto-video-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jzferrell26/auto-video-agent/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/jzferrell26/auto-video-agent)](package.json)
[![License](https://img.shields.io/github/license/jzferrell26/auto-video-agent)](LICENSE)

## Quickstart

Install [Node.js 22+](https://nodejs.org/en/download) and Git. Then run:

```bash
git clone https://github.com/jzferrell26/auto-video-agent.git
cd auto-video-agent
npm ci
npm run check
npm run demo
```

The demo creates a silent, text-only MP4 at `out/demo-<unique-id>/demo.mp4`.
No footage, API keys, paid AI account, or FFmpeg installation is needed for this first render.
The first render downloads a browser runtime and fonts, so internet access is required.

Use **Use this template > Create a new repository** if you want your own student copy.
Replace the links and CODEOWNERS identity in that copy.

[Features](#features) · [Install](#install) · [Usage](#usage) · [Configuration](#configuration) · [Contributing](#contributing) · [License](#license)

## Features

- Create animated text shorts from an editable JSON brief.
- Render the same brief in vertical, square and landscape formats.
- Cut lessons from a recording with an explicit timestamp map.
- Burn word-timed captions into lessons, voiceovers and short clips.
- Customize colors, logos, titles and copy per job.
- Generate synthetic practice footage without sharing client recordings.
- Preview optional GoHighLevel delivery locally before explicitly authorizing uploads.

This is a file-driven toolkit, not an autonomous video director. You choose the cuts,
review captions and approve the results. It does not generate a script, select highlights,
guarantee conversions, or publish content automatically.

## Install

The quickstart installs the included Remotion host and pinned npm dependencies.
For Studio, run `npm run studio`.

For recording-based lessons and synthetic footage, install [FFmpeg](https://ffmpeg.org/download.html)
and ensure both `ffmpeg` and `ffprobe` are on PATH.

For optional local transcription, install Python 3.11+ and `faster-whisper` in a virtual
environment. See [setup and troubleshooting](docs/getting-started.md). You do not need
Python for the text demo.

## Usage

### Make a short in three formats

Render the included brief with a new output name:

```bash
npm run render:platforms -- engine/examples/demo-short.json practice
```

Outputs: `out/practice-9x16.mp4`, `out/practice-1x1.mp4`, and
`out/practice-16x9.mp4`. Use a new slug for another run; scripts refuse to replace outputs.

### Practice cutting lessons

With FFmpeg installed:

```bash
npm run demo:media
npm run build:lessons -- public/demo/source.mp4 public/demo/captions.json engine/examples/demo-course.json practice
```

This creates two lessons under `out/lessons/`. The practice source uses a test pattern
and test tone. Its captions are invented, not a transcription.

### Inspect optional delivery

Preview the delivery plan locally:

```bash
npm run deliver:ghl -- engine/examples/demo-course.json practice
```

This defaults to a local preview. It does not read delivery credentials, render, upload,
or import. Actual delivery is an advanced, opt-in workflow described in
[the delivery guide](docs/ghl-delivery.md).

## Configuration

Your theme, logo and content belong in job JSON, not the engine. Copy examples into
`brand-props/` for local customization; keep your recordings in `_sources/`.
Both directories, `public/`, and `out/` are ignored by Git.

The optional delivery adapter reads `GHL_LOCATION_ID` and `GHL_PIT` from your
environment or ignored `.env`. Both default to unset. No credentials are needed for local rendering.

See [the engine reference](engine/README.md) for compositions, commands and data formats,
and [safe student workflows](docs/student-workflow.md) for privacy and review checkpoints.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm run check` before opening a pull request.
Use [SUPPORT.md](SUPPORT.md) for help and [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

Project source is licensed under the [MIT License](LICENSE).

Remotion uses a separate source-available license, not MIT. FFmpeg, fonts, model weights,
music and your own media have separate terms. Read [NOTICE.md](NOTICE.md) before
commercial use or redistribution. The project license does not license your input media.
