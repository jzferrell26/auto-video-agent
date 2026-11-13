# Optional: clone video with your own HeyGen voice and avatar

This optional module turns an approved script into a 9:16 talking-head Short that uses
**your own** HeyGen professional voice clone and **your own** avatar look. Nothing else in
this toolkit needs it. It spends HeyGen credits, so every paid or uploading step only shows
a preview until you add `--run`. It never publishes anything.

The route is audio first: you generate and master the voice, check it by ear, and only then
pay for lip-sync. The finished clip, captions and B-roll become props for the `SplicedShort`
composition, which you render locally.

## 1. Consent comes first

Only clone an adult who gave you written consent for this use. Your own clone counts: you
still write a record for yourself. Every clone command reads the record before it does
anything else and stops if the record is missing, expired, revoked, future-dated, or does
not cover what the command is about to do.

1. Copy [the example record](../engine/examples/clone-consent.example.json) to
   `clone-private/consent/<name>.json`. The `clone-private/` folder is ignored by Git, and
   the hygiene check (`npm run check:hygiene`) fails if a file from it is ever tracked.
2. Replace every invented value with the real record and delete the `isExample` line.
   The tool refuses the unedited template.
3. Pass it to every command with `--consent clone-private/consent/<name>.json`.

| Field | What it records |
|---|---|
| `person.name`, `person.adultConfirmed` | Who is cloned; the person is 18 or older |
| `authorizes.voice`, `authorizes.likeness` | What may be cloned. Speech, mastering and upload need voice; lip-sync, sync and props need both |
| `scope.uses`, `scope.excludedUses` | Allowed uses (for example `short-form`) and uses the person ruled out |
| `platforms` | Where the clone may appear. A job for any other platform is refused |
| `aiDisclosure.acknowledged` | The person read the platform disclosure facts below |
| `signedOn`, `expires` | Date signed, and an end date or `until-revoked` |
| `revocation.contact`, `revocation.revokedOn` | How the person withdraws, and the date if they did |
| `recordedBy`, `method` | Who recorded it, and how (`signed-document`, `written-message` or `recorded-statement`) |

This record is a workflow guard, not a legal form; it cannot make consent adequate under
any law. HeyGen runs its own consent step for digital twins
([Avatar Consent](https://developers.heygen.com/docs/avatar-consent)); this record does not
replace it, and it does not replace this record.

## 2. What you need

- A HeyGen account with API access, a professional voice clone and at least one avatar look
  of the consenting person, all created in that account. This module never creates voices
  or avatars.
- An API key from your HeyGen account in `HEYGEN_API_KEY`, set in your environment or in
  the ignored `.env` file (see [.env.example](../.env.example)). It is never printed or saved.
- FFmpeg and ffprobe on PATH ([setup guide](getting-started.md)). Python with
  faster-whisper is optional, for word timings.
- `clone-private/config.json`, copied from
  [the example config](../engine/examples/clone-config.example.json), with your own voice id
  and look ids. Give each look a short name such as `desk-a`; commands use the names, so ids
  stay out of the repository, your shell history and your job files.
- A job file per piece in the ignored `brand-props/` folder, copied from
  [the example job](../engine/examples/clone-job.example.json): the approved script, the
  date it was approved, use, platforms, emphasis words, kickers and B-roll.

## 3. The route, and why audio comes first

| Step | Command | What happens | External effect |
|---|---|---|---|
| Preview | `plan` | Checks consent, job and config; lists every step | None |
| 1 | `speech` | Text to speech with your voice clone at the speed you choose | Spends credits (`--run`) |
| 2 | `master` | High-pass, compressor or gate, makeup gain, limiter; loudness checked after AAC | Local |
| 3 | `upload` | Uploads the mastered voice as a HeyGen asset | Uploads your voice (`--run`) |
| 4 | `lipsync` | Your look lip-syncs the uploaded voice; polls, then downloads | Spends credits (`--run`) |
| 5 | `sync` | Measures the render's audio lag, then puts the mastered voice on the picture | Local |
| 6 | `captions` | Times the approved script's words from a whisper word list | Local |
| 7 | `props` | Writes `SplicedShort` props with captions, kickers and B-roll | Local |
| Batch | `looks` | Assigns looks so no two pieces in a row share one | Local |

Every command takes `--consent`; most take `--slug <name>`, and `plan`, `speech`, `upload`,
`lipsync`, `captions` and `props` also take `--job`, so the steps that send your voice or
likeness to HeyGen re-check the job's use and platforms against the consent record. Run
`npm run clone -- --help` for every option.

```bash
npm run clone -- plan --consent clone-private/consent/me.json --slug tip-01 --job brand-props/tip-01.json
npm run clone -- speech --consent clone-private/consent/me.json --slug tip-01 --job brand-props/tip-01.json --speed 1.1
```

Why audio first: lip-sync follows the audio exactly, so the voice has to be final before you
pay for video. Choosing the speed, mastering and listening happen while changes are cheap.
Mastering after lip-sync would mean the picture no longer matches what was rendered, and
re-rendering costs credits again.

## 4. Costs and credits

Speech and lip-sync spend credits from your HeyGen plan; the amount depends on your plan,
so check your usage in HeyGen before a batch. This module does not estimate prices.

- Paid steps only run with `--run`. Without it they print what they would send.
- A lip-sync request is not a finished video. The command waits until HeyGen reports
  `completed`, downloads the file, and only then reports success.
- Lip-sync and upload requests carry an idempotency key, so an accidental repeat within 24
  hours replays the first request instead of starting a second one.
- If polling times out, the video may still finish. Run the same `lipsync --run` command
  again: it resumes polling the video already requested instead of paying for a new one.
- Nothing is retried after a network failure, because a request may already have been
  charged. Check your HeyGen dashboard first.

## 5. Step details

### Speech and speed

`speech` always sends a speed, because the API does not inherit the speed you chose in the
HeyGen app. Pick it with `--speed` (or `voice.speed` in the config); HeyGen accepts 0.75 to
1.25, so 1.1 reads about ten percent faster. Speed applies to professional voice clones;
instant clones accept the value and ignore it. The default model is `heygen-voice-1`.
Listen to `out/clone/<slug>/speech-raw.wav` before you continue.

### Mastering targets

`master` cleans and levels the voice before lip-sync: a high-pass at 80 Hz, a compressor
(threshold -20 dB, ratio 2.5:1; or `--dynamics gate`), makeup gain, and a limiter with its
ceiling at 0.72 (about -2.9 dBFS). It then encodes an AAC check file and measures it with
FFmpeg's `ebur128` filter (true peak on):

- integrated loudness about **-14 LUFS** (within 1 LU, `--target-lufs` to change it);
- true peak **under -1.5 dBTP**.

The check runs on AAC because that is what platforms receive, and AAC can raise peaks. The
makeup gain is measured, not guessed, with one correction pass. If a target is missed,
nothing is written. You can master the person's own recording instead of generated speech
with `--input _sources/take.wav`.

### Upload

`upload` uses HeyGen's direct upload: create the upload, PUT the bytes to the presigned URL
it returns (the API key is never sent there), then complete it. HeyGen stores the file in
your workspace and returns a public URL for it; this tool never prints or saves that URL.
A voice recording is personal data, so delete the asset in HeyGen when you no longer need
it. Files over 32 MB or 600 seconds are refused, matching HeyGen's documented limits.

### Lip-sync

`lipsync --look desk-a` renders 9:16 for a portrait look and 16:9 for a landscape look
(`--aspect` overrides). `--engine` picks a rendering engine; HeyGen uses Avatar IV when it
is omitted. Status is polled with growing delays (10 s, then up to 60 s) until `completed`
or `failed`, with a 20-minute default timeout (`--timeout-min`).

### The sync check

`sync` decodes both the downloaded render's audio and your mastered voice to mono 16 kHz
PCM and estimates the lag by cross-correlation. It requires **0 ms** by default
(`--max-lag-ms` to allow more) and a match score of at least 0.5, which catches a render
made from the wrong audio. Only then does it build the clip: the render's video stream is
copied untouched, the mastered voice is added as AAC 320k, the length is capped to the
video, and the file is written for fast start. The clip lands in `public/clone/<slug>/`.

### 16:9 looks

A landscape look is reframed for a 9:16 Short: a 4:5 window centered on the face sits over a
blurred, dimmed fill of the same shot, with the mastered voice muxed in. Set the face's
horizontal position from 0 (left edge) to 1 (right edge) as `faceX` in the config or with
`--face-x`. Crop widths are even and both crops are clamped to the frame.

### Captions from the approved script

Captions use the words of the approved script, never a transcript's guesses. Transcribe the
mastered voice to get timings:

```bash
python engine/pipeline/transcribe_full.py out/clone/tip-01/voice-master.wav base.en
npm run clone -- captions --consent clone-private/consent/me.json --slug tip-01 --job brand-props/tip-01.json --words out/clone/tip-01/voice-master.words.json
```

Whisper sometimes splits one written token in two (`high -level`, `10 ,000`,
`example .com`); a token that starts with `-`, `.`, `,` or `/` is joined to the one before
it. The script and the heard words are then aligned like Python's `difflib`: matching runs
copy whisper's times, mismatched runs (for example "two thousand" heard as "2,000") share
whisper's span evenly, and script words whisper missed are fitted between their neighbours.
Words in the job's `emphasis` list are marked for highlighting. If fewer than 60 percent of
the script words were heard as written (`--min-match`), the step stops: the words file
probably belongs to a different take. Review the captions against the audio before you
render.

### B-roll crop width

Full-width screen captures are unreadable on a phone. Each B-roll clip in the job is
cropped to about **560 to 640 px wide** around the part that matters, and the crop must stay
inside the source frame. The `brollWidth` job setting changes the range when a source
calls for it. Anchor a clip to script phrases (`fromPhrase`, `toPhrase`) or to times.
Clips sit under `public/`, and their paths are relative to it.

### Look rotation

A feed of identical framing reads as templated. `looks` assigns your looks to an ordered
batch so that no two pieces in a row share a look, spreading use evenly. With
`--save-state`, the last look name (never an id) is kept in the ignored
`clone-private/state.json`, and the next batch will not start on it. It stops with an error
when a repeat cannot be avoided, for example two pieces and one look.

```bash
npm run clone -- looks --consent clone-private/consent/me.json --batch tip-01,tip-02,tip-03 --save-state
```

### Props for SplicedShort

`props` writes `brand-props/clone-<slug>.json` with one segment (the synced clip on a 30 fps
grid), the aligned captions, B-roll as `clip` cutaways (crop, source size, optional eyebrow;
the cutaway whoosh sound is off), and kickers (`atMs`, `durMs`, `text`). The `SplicedShort`
composition is added to this toolkit separately; once it is registered, render with:

```bash
npx remotion render src/index.tsx SplicedShort out/clone-tip-01.mp4 --props=brand-props/clone-tip-01.json
```

Watch and listen to the whole render before you share it.

## 6. HeyGen API calls

Checked against HeyGen's developer documentation on 2026-11-12. All calls go to
`https://api.heygen.com` with the `X-Api-Key` header
([API key](https://developers.heygen.com/docs/api-key)).

| Step | Call | Source |
|---|---|---|
| speech | `POST /v3/models/audio/tts` with `voice_id`, `text`, `model`, `speed` (0.75 to 1.25), optional `language`; returns `audio_url` and `duration` | [Generate Speech](https://developers.heygen.com/reference/generate-model-speech) |
| upload | `POST /v3/assets/direct-uploads` with `filename`, `content_type` (`audio/wav`), `size_bytes`, `checksum_sha256` | [Create Asset Upload](https://developers.heygen.com/reference/create-asset-upload), [Direct Upload](https://developers.heygen.com/docs/direct-upload) |
| upload | `PUT` the bytes to `upload_url` with exactly the `upload_headers` | [Direct Upload](https://developers.heygen.com/docs/direct-upload) |
| upload | `POST /v3/assets/{asset_id}/complete` | [Complete Asset Upload](https://developers.heygen.com/reference/complete-asset-upload) |
| lipsync | `POST /v3/videos` with `type: avatar`, `avatar_id`, `audio_asset_id`, `aspect_ratio`, `resolution`, optional `engine` | [Create Video](https://developers.heygen.com/reference/create-video), [Audio to Video](https://developers.heygen.com/audio-to-video) |
| lipsync | `GET /v3/videos/{video_id}` until `status` is `completed` (or `failed`), then download `video_url` | [Get Video](https://developers.heygen.com/reference/get-video) |

Limits used: lip-sync audio up to 32 MB and 600 seconds; `Retry-After` honoured on HTTP
429, and 502, 503 and 504 retried, as the speech reference allows
([Usage Limits](https://developers.heygen.com/docs/usage-limits)). The Avatar 6 engine names
`heygen-avatar-6` and `heygen-avatar-6-turbo` come from the
[Avatar 6 page](https://developers.heygen.com/docs/models/avatar-6); the create-video
reference lists `avatar_iii`, `avatar_iv` and `avatar_v`.

**UNVERIFIED** (the docs do not say, so the code takes the cautious path):

- Whether downloading `audio_url` or `video_url` needs the API key. The tool never sends the
  key to a download or upload host.
- How long `audio_url` and `video_url` stay valid. Download promptly.
- Whether HeyGen's exports carry C2PA Content Credentials. Platforms may detect AI video by
  other means either way.

## 7. Platform disclosure facts

Checked on the official pages on 2026-11-12. Platforms change these rules; read the pages
again before you publish. This is not legal advice.

- **YouTube asks you to disclose realistic altered or synthetic content.** In YouTube
  Studio, the Attributes section has an "AI use" setting. It covers content that makes a
  real person appear to say or do something they did not. YouTube may apply a label itself,
  including for content with C2PA metadata or content its systems detect, and creators who
  consistently do not disclose may get a label applied manually or be suspended from the
  YouTube Partner Program.
  Source: [YouTube Help, disclosing altered or synthetic content](https://support.google.com/youtube/answer/14328491).
- **YouTube auto-labels undisclosed realistic AI.** Since May 27, 2026, when YouTube's
  systems detect significant photorealistic AI use that was not disclosed, it applies a
  label automatically. Labels stay permanent in some cases, including content whose C2PA
  metadata marks it as fully generative AI.
  Source: [YouTube Official Blog, improving AI labels](https://blog.youtube/news-and-events/improving-ai-labels-viewers-creators/).
- **Meta (Facebook and Instagram) requires its disclosure tool** for organic posts with
  photorealistic video or realistic-sounding audio that was digitally created or altered,
  and may apply penalties otherwise. Meta also uses industry standards such as C2PA to
  identify AI content and shows an "AI info" label.
  Source: [Meta Newsroom, preparing for the 2026 US midterms](https://about.fb.com/news/2026/02/meta-prepares-for-2026-us-midterms/).
- **TikTok requires a label on realistic AI content.** Its Community Guidelines (effective
  September 24, 2026) require creators to label AI-generated or significantly edited
  content that shows realistic-looking scenes or people; unlabeled content may be removed,
  restricted or labeled by TikTok.
  Source: [TikTok Community Guidelines, integrity and authenticity](https://www.tiktok.com/community-guidelines/en/integrity-authenticity).
  TikTok says it labels AI content using C2PA Content Credentials, creator labeling tools
  and invisible watermarking
  ([TikTok Newsroom](https://newsroom.tiktok.com/helping-people-spot-and-understand-ai-generated-content-on-tiktok?lang=en-GB)).
  TikTok Shop Academy, a commerce guide, names the "AI-generated content" toggle in post
  settings, says a label may be applied automatically when content contains specific
  technical metadata, and says creators cannot remove a label the platform applied
  ([TikTok Shop Academy](https://seller-us.tiktok.com/university/essay?knowledge_id=491489038501663&lang=en)).
  UNVERIFIED: whether C2PA metadata alone triggers TikTok's automatic label; neither page
  says so directly.
- **Links in YouTube Shorts descriptions and comments are not clickable.** YouTube makes
  those URLs non-clickable to reduce spam and scams
  ([YouTube Help, link clickability](https://support.google.com/youtube/answer/13748639)).
  Point viewers to a Related Video link instead: it shows a clickable link below your
  channel handle, needs advanced feature access, and the linked video must be public or
  unlisted ([YouTube Help, related video on Shorts](https://support.google.com/youtube/answer/14075157)).
- **TikTok's commercial content disclosure setting** must be turned on for content that
  promotes a brand, product or service. TikTok counts financial incentives, meaning money or
  benefits for promoting something, with URLs and promo codes as examples; the labels are
  "Paid partnership" and "Commercial content", and undisclosed content may not be eligible
  for the For You feed
  ([TikTok, content disclosure setting](https://ads.tiktok.com/help/article/about-the-content-disclosure-setting-for-creators)).
  The page does not use the word "affiliate"; reading an affiliate link as a financial
  incentive is this guide's interpretation, so turn the setting on for affiliate and paid
  posts.

Whatever the platform settings, an endorsement or affiliate relationship should also be
disclosed inside the video itself, and a clone should never deliver a testimonial, a
review, or a claim about what viewers will earn.

## 8. Privacy and safety checklist

- The API key lives only in your environment or the ignored `.env`. Errors show an HTTP
  status and a known error code, never the provider's response body.
- Voice, avatar, asset and video ids live only in `clone-private/config.json`, command
  arguments, or the ignored `out/` reports. Terminal output masks them.
- Media and reports stay in ignored folders: `out/clone/<slug>/`, `public/clone/<slug>/`
  and `brand-props/`.
- Outputs are never overwritten; use a new slug for a new version.
- Nothing is published, scheduled or posted. Applying each platform's AI and paid-promotion
  settings is your decision at upload time.
