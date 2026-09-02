# Contributing

Small, reproducible improvements are welcome. Start with a bug report or proposal before a large change.

## Development

Create a short-lived branch from current main. Use Node.js 22 or later and the committed npm lockfile. Run `npm ci`, `npm run check`, and `npm run demo` before opening a pull request. Describe what changed, why, how you tested it, and any compatibility impact. Use a Conventional Commit title such as `fix: validate lesson timestamps`.

## Safe contributions

- Use invented example copy and synthetic media only.
- Never attach client recordings, transcripts, personal contacts, tokens, account IDs, private links, or real brand assets to public issues or pull requests.
- Keep local recordings, generated props, renders and credentials in ignored directories.
- Check `git diff --cached` and `git status --short` before every commit. Ignore rules do not remove files already tracked by Git.
- Do not add automatic uploads, publishing, telemetry, or paid services to the demo or CI.
- Preserve upstream licenses and notices. Confirm you have the rights to contribute all code and assets.

## Review and maintenance

All changes go through a pull request. Required checks must pass and review conversations must be resolved before merge. Prefer squash merges. Do not force-push main. Maintainers handle reviews through GitHub; no personal contact information is required in this project.

The root project has a maintainer listed in `.github/CODEOWNERS`. Replace that owner with your own real user or team when you create a student copy. Do not add fictitious owners.

See [the community standards](CODE_OF_CONDUCT.md), [support](SUPPORT.md), and [security policy](SECURITY.md).
