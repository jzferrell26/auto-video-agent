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

[Features](#features) · [Install](#install) · [Usage](#usage) · [Configuration](#configuration) · [AI assistants](#use-with-ai-assistants) · [Contributing](#contributing) · [License](#license)

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

## Use with AI assistants

Open the repository root (the folder containing `package.json`) in your coding assistant.
The project includes shared setup, privacy and verification instructions:

| Assistant | Project entry point |
|---|---|
| Codex | [AGENTS.md](AGENTS.md) |
| Claude Code | [CLAUDE.md](CLAUDE.md), which imports AGENTS.md |
| Cursor Agent | [project-guide.mdc](.cursor/rules/project-guide.mdc), which points to AGENTS.md |

No custom plugins, global rules or personal agent configuration are required. You still
need your chosen assistant installed and its normal account/access. Keep its permission
controls enabled. Project instructions do not prevent every unsafe action.

Start a fresh session after updating the instruction files. Before giving the assistant
private media, try this with the public demo:

```text
Read AGENTS.md and README.md. Name the project instruction files you loaded,
the verification commands, and the actions that require my approval.
Then check prerequisites, install the locked npm dependencies if needed,
run npm run check and npm run demo, and tell me the output path.
Use only the included synthetic examples. Do not upload or publish anything.
```

If the assistant does not load the guide, explicitly attach `AGENTS.md` and ask it to
read it before continuing. In Claude Code, `/context` shows which instruction files
loaded under Memory files; in Cursor, check the active project rules. Plain chat/API
clients without repository access need you to supply the instructions yourself.

Discovery references: [Codex instructions](https://developers.openai.com/codex/guides/agents-md),
[Claude Code memory](https://code.claude.com/docs/en/memory), and
[Cursor rules](https://cursor.com/docs/rules). These files use the documented formats;
check loading in your installed client rather than assuming identical behavior everywhere.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm run check` before opening a pull request.
Use [SUPPORT.md](SUPPORT.md) for help and [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

Project source is licensed under the [MIT License](LICENSE).

Remotion uses a separate source-available license, not MIT. FFmpeg, fonts, model weights,
music and your own media have separate terms. Read [NOTICE.md](NOTICE.md) before
commercial use or redistribution. The project license does not license your input media.
