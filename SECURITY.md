# Security policy

## Reporting a vulnerability

Use this repository's **Security > Report a vulnerability** button for a private report. Include the affected commit, a minimal reproduction with synthetic data, impact, and a possible fix if known. Do not put secrets or vulnerability details in a public issue. Do not test against accounts or media you do not own.

The latest main branch is the supported development version. There is no guaranteed response-time or commercial support commitment.

## Local data and credentials

This is a local media tool, not an untrusted multi-user rendering service. Only run trusted scripts and job configurations. Review every asset URL before rendering. Downloaded fonts, browser runtimes and transcription models may contact their providers during setup. Optional delivery sends media to an external service and needs your own authorization.

Keep secrets in environment variables or ignored `.env` files. Never commit recordings, transcripts, signed media URLs, account identifiers, or generated delivery manifests. Review logs before sharing them.

If a credential leaks, revoke or rotate it first. A later deletion commit does not erase Git history, pull request refs, forks or caches. Coordinate any history cleanup with maintainers and GitHub Support. See [GitHub's removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
