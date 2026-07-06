# GoHighLevel delivery reference

The optional GHL adapter uploads lesson videos to a sub-account's media library and imports
them as a **draft** course. Verified against GoHighLevel's official OpenAPI
(`github.com/GoHighLevel/highlevel-api-docs`, `apps/courses.json` + `apps/v3/medias-v3.json`),
not from memory. Confirm current terms in the [marketplace docs](https://marketplace.gohighlevel.com/docs/).

## Auth

- A **sub-account (location) Private Integration Token**, `Authorization: Bearer <token>`.
- Scopes required: **`medias.write`** (upload) and **`courses.write`** (import).
- Create the token in the sub-account: Settings -> Private Integrations.

## 1. Upload media (get a hosted URL)

```
POST https://services.leadconnectorhq.com/medias/upload-file
Header: Version: v3
Body: multipart/form-data { file, name? }
```

- Limits: 25 MB for generic files, **500 MB for video** (use the v3 spec for the video limit).
- Returns `{ fileId, url }`. `url` is a public CDN link (`assets.cdn.filesafe.space/...`) you use
  as a lesson's `bucketVideoUrl` or a course/lesson image.

## 2. Import a course

```
POST https://services.leadconnectorhq.com/courses/courses-exporter/public/import
Header: Version: 2021-07-28, Content-Type: application/json
```

Body (`PublicExporterPayload`):

```
{
  "locationId": "<sub-account id>",
  "products": [{                 // product = a course
    "title", "description",
    "imageUrl",                  // course cover (a hosted image URL)
    "instructorDetails": { "name", "description" },   // name + bio only; no image field
    "categories": [{             // category = a module/section
      "title", "visibility": "draft"|"published",
      "thumbnailUrl",            // module image
      "posts": [{                // post = a lesson
        "title", "visibility",
        "contentType": "video"|"assignment"|"quiz",
        "description",
        "thumbnailUrl",          // lesson thumbnail
        "bucketVideoUrl",        // the hosted video URL from step 1
        "postMaterials": [{ "title", "type", "url" }]   // optional downloads
      }]
    }]
  }]
}
```

- Async: returns `201` with `{ processingCourses: [{ id, title, url }] }`; copying runs in the
  background.
- **Import-only API.** There is no public GET / update / delete for courses. Set everything at
  import; to change a course afterward, edit in the GHL UI or re-import a fresh copy.
- **Not settable via the API:** the instructor headshot/photo, the instructor title field, and
  the "Meet Your Coach" heading. Those are UI-only. `instructorDetails` supports name + bio only.
- Use `visibility: "draft"` everywhere so nothing goes live to members until a human publishes.
