# NOTICE: dependencies and their licenses

This project's own code is **MIT** (see `LICENSE`). It orchestrates several third-party
tools that have **their own licenses**, which are your responsibility to comply with. Read
this before using the tool commercially.

## Render engine: Remotion (source-available, not MIT)

This tool renders video with [Remotion](https://www.remotion.dev). Remotion is **not** open
source under a permissive license. Per its [license](https://www.remotion.dev/docs/license),
it is **free** for:

- individuals,
- non-profit organizations,
- for-profit companies with **3 or fewer employees**, and
- non-commercial evaluation.

A company with **more than 3 employees using it commercially needs a paid Remotion Company
License**. The trigger is your organization's size and commercial use, not what you render.
Confirm the current terms and pricing at https://www.remotion.dev/docs/license before relying
on this. We render on Remotion because it is validated and works today; if you need a fully
permissive render path, the render layer is designed to be portable to
[Revideo](https://github.com/redotvideo/revideo) (MIT). That port is a tracked follow-up.

## Other dependencies

| Tool | Role | License |
|---|---|---|
| Remotion + `@remotion/*` | render engine | Remotion License (see above) |
| FFmpeg | clip / trim / encode | LGPL/GPL (depends on build) |
| faster-whisper | transcription | MIT (model weights: MIT) |
| Node.js, Python | runtime | MIT / PSF |

## GoHighLevel delivery (optional)

The GoHighLevel delivery adapter uses the [HighLevel API](https://marketplace.gohighlevel.com/docs/)
(Courses import + Media upload). It requires your own sub-account token with the `courses.write`
and `medias.write` scopes. No credentials are included in this repo. See `docs/ghl-delivery.md`.

## Not included

Any AGPL prototype scaffolding (e.g. OpenMontage) used during development is **not** part of
this repository. The render components here are original and import only Remotion and
`@remotion/google-fonts`.
