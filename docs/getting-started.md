# Set up your first video workflow

Start with the text-only demo in the [README](../README.md). It requires Git, Node.js
22+ and internet access for npm, browser and font downloads. It needs no API account.

## Open the editor

From your installed repository, start Studio:

```bash
npm run studio
```

Choose BrandedShort or CourseCover. Edit the sample JSON for a CLI render, or edit the
default props in `src/Root.tsx` to change the initial Studio examples. Studio is local
development software; do not expose it publicly.

## Add practice footage

Install FFmpeg from [its official download links](https://ffmpeg.org/download.html).
Open a new terminal after changing PATH, then verify:

```bash
ffmpeg -version
ffprobe -version
npm run demo:media
```

The generator creates a six-second test pattern and tone, not a person or a real voice.
Now LessonVideo, MicroClip and CaptionedShort can preview their defaults in Studio.
The generator refuses to overwrite existing demo files.

## Add local transcription

Python is optional. Create a separate environment:

Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install faster-whisper
.venv\Scripts\python.exe engine/pipeline/transcribe_full.py _sources/session.mp4 base.en
```

macOS or Linux:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install faster-whisper
.venv/bin/python engine/pipeline/transcribe_full.py _sources/session.mp4 base.en
```

Before the last command, create `_sources/` and put your own authorized recording at
`_sources/session.mp4`. The model downloads on first use. The default `base.en` model
is English-only; pass a suitable multilingual model name for other languages.

The optional Python stack is not included in the npm lockfile. Record your installed
Python/model versions for reproducibility. CI checks Python syntax, not transcription
accuracy or model downloads.

## Troubleshoot

| Symptom | Check |
|---|---|
| npm cannot find package.json | Run from the repository root, not engine/ |
| Browser/font download fails | Check network access and proxy settings; retry after resolving connectivity |
| FFmpeg not found | Install FFmpeg and reopen the terminal with the updated PATH |
| Default video/audio missing | Run `npm run demo:media` before the three media-based previews |
| Output already exists | Choose a fresh slug; inspect partial outputs before cleanup |
| Captions do not match | Review transcription timing and cuts against the actual recording |
| GHL preview did not upload | Expected: default delivery is a local preview; see the explicit upload guide |

Never resolve an error by pasting tokens, full transcripts or client media into public issues.
