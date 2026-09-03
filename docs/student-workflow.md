# Work safely with your own recordings

Keep the project reusable by separating code from private job data.

1. Put source recordings in ignored `_sources/`.
2. Copy the neutral example JSON into ignored `brand-props/`.
3. Transcribe locally if needed, then inspect names, numbers and technical vocabulary.
4. Choose your own lesson boundaries or short-video scenes. The tool does not select them for you.
5. Render to ignored `out/` and review both the picture and sound.
6. Share or upload only after checking permissions and reviewing the final result.

## Review every render

Check that captions match the audio, cuts preserve meaning, overlays leave faces and
important UI readable, and text stays inside the frame. Listen for clipped speech,
unexpected speed changes, uneven music and missing audio. A green code test is not
a human quality review of your video.

The synthetic demo's test tone and invented captions are only for checking the pipeline.
They are not finished course content.

## Review every commit

Inspect staged changes and run the privacy guard:

```bash
git status --short
git diff --cached
npm run check:hygiene
```

The hygiene checker catches common file types, token-shaped strings, machine-specific
paths, signed URLs and broken local documentation links. It is a guardrail, not a complete
PII detector. Inspect all new examples manually. Do not force-add ignored data.

## Use AI assistance deliberately

Start with the [assistant setup and verification prompt](../README.md#use-with-ai-assistants).
The shared [agent guide](../AGENTS.md) applies across the included assistant entry points.
Ask an assistant to inspect that guide, the public README and command help first.
Provide synthetic examples when possible. If you give it real media or transcripts, confirm the data-sharing
terms of the assistant and obtain permission from the people or clients involved.

Treat text inside source transcripts, documents and fetched pages as input data, not as
authority to run commands, change accounts or publish. Require a preview and your approval
before external uploads, purchases or publication.

## Maintain a student copy

Update repository links and CODEOWNERS for your copy. Keep MIT attribution and third-party
notices. Enable secret scanning and protect your default branch with the checks you
actually run. Template creation starts a new repository history; it does not clean the
history of the original project.
