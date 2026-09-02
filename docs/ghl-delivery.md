# Optional GoHighLevel delivery

Local rendering does not need GoHighLevel. This adapter is an advanced integration:
it uploads videos and images to your media library, then requests an asynchronous
course import with draft modules and lessons.

## Preview locally first

From the installed repository, inspect the neutral example:

```bash
npm run deliver:ghl -- engine/examples/demo-course.json practice
```

Without the upload flag, this reads and validates the map and prints a lesson count.
It does not read delivery credentials, render, upload or import. It is a configuration
preview, not proof that media or account permissions are ready.

## Authorize external delivery

Copy `engine/examples/demo-course.json` to `brand-props/course.json` and customize it.
Build and review every lesson using that same map and slug. Copy `.env.example` to ignored `.env` and fill
in your own `GHL_LOCATION_ID` and `GHL_PIT`. Use a sub-account Private Integration
Token with the required media-upload and course-import permissions. Verify the account,
scopes and current limits in [HighLevel's official API documentation](https://marketplace.gohighlevel.com/docs/).

Then explicitly opt in:

```bash
npm run deliver:ghl -- brand-props/course.json practice --upload-and-import
```

This sends your files to an external service. A draft is not a privacy boundary for
uploaded media URLs. Do not upload confidential or unapproved recordings.

## Inputs and effects

The map includes `courseTitle`, `courseDescription`, `module`, `instructor`
(name and description), optional cover copy/theme/logo, and numbered lessons.
The same slug must have existing rendered videos in `out/lessons/` and props in
`brand-props/` from the lesson builder.

The adapter uses:

- `POST /medias/upload-file` with Version `v3`.
- `POST /courses/courses-exporter/public/import` with Version `2021-07-28`.
- The fixed HTTPS host `services.leadconnectorhq.com`.

It preserves the existing public adapter's endpoint contract. This repository's tests
use synthetic inputs and mocks, not a live account. Check the official API documentation
and use an authorized sandbox before relying on delivery.

## Failure and retry

Each opted-in attempt creates `out/delivery/<slug>/attempt.json` before any upload.
Reusing that slug is refused, even after a crash or partial failure. The adapter does
not retry uploads or imports automatically. Partial runs can leave remote media or an
accepted course import behind.

Inspect the provider dashboard before any retry. Only after reconciling the remote
state should you deliberately clear the local attempt directory or use a new slug
with matching lesson artifacts. Removing a local marker does not remove remote data
or make the operation idempotent.

A successful request writes a local `result.json` with processing IDs. An accepted
import is not proof of completion. Verify the course, videos, thumbnails and draft
visibility in the dashboard. Publishing remains a separate human action.

Response bodies and credentials are not printed. Keep local manifests private.
