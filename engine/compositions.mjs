// Single source of truth for the Remotion compositions in this toolkit.
//
// Three consumers, so a composition cannot drift from its documentation:
//   - engine/pipeline/validate-props.mjs  fails a render before ffmpeg or Remotion run
//   - engine/pipeline/gen-docs.mjs        regenerates the composition tables in engine/README.md
//   - engine/pipeline/render-job.mjs      picks `remotion still` vs `render`, and which prop
//                                         receives a fetched source file
//
// The prop names mirror the exported prop types in engine/remotion/*.tsx. A test
// (tests/compositions.test.mjs) reads those files and fails if the two lists disagree.
//
// `still: true` marks a composition that renders one frame (a PNG) rather than a video.
//
// Schema vocabulary (deliberately small, see validate-props.mjs):
//   {type:"string"} {type:"number"} {type:"integer"} {type:"boolean"}
//   {type:"object"} {type:"enum", values:[...]} {type:"array", of:{...}}
// Every field is optional unless `required: true`. `min`/`max` apply to number/integer.

/** A word-level caption timing, as written by engine/pipeline/transcribe.py. */
const WORD_CAPTION = {
  type: "object",
  fields: {
    word: { type: "string", required: true, allowEmpty: true },
    startMs: { type: "number", required: true, min: 0 },
    endMs: { type: "number", required: true, min: 0 },
  },
};

/** Theme colors shared by the brand compositions (any CSS color string). */
const BRAND_THEME = {
  type: "object",
  fields: {
    cream: { type: "string" },
    slate: { type: "string" },
    teal: { type: "string" },
    gold: { type: "string" },
    sage: { type: "string" },
  },
};

/** SplicedShort has its own theme: colors plus two CSS font-family strings. */
const SPLICED_THEME = {
  type: "object",
  fields: {
    background: { type: "string" },
    surface: { type: "string" },
    foreground: { type: "string" },
    accent: { type: "string" },
    muted: { type: "string" },
    success: { type: "string" },
    fontFamily: { type: "string" },
    displayFontFamily: { type: "string" },
  },
};

/** Optional render-target size. */
const DIMENSIONS = {
  width: { type: "integer", min: 16 },
  height: { type: "integer", min: 16 },
};

const MAX_MS = 600000;
const durMs = { type: "number", required: true, min: 0, exclusiveMin: true, max: MAX_MS };

export const COMPOSITIONS = {
  BrandedShort: {
    output: "Animated text short from a brief (9:16, 1:1 or 16:9)",
    props: {
      theme: BRAND_THEME,
      logo: { type: "string" },
      // The scene list is a TypeScript union. Validate the two fields the layout math needs:
      // a bad `type` renders nothing, and a missing or NaN `seconds` corrupts every start frame.
      scenes: {
        type: "array",
        minLength: 1,
        required: true,
        of: {
          type: "object",
          fields: {
            type: { type: "enum", values: ["intro", "statement", "truth", "list", "outro"], required: true },
            seconds: { type: "number", required: true, min: 0, exclusiveMin: true },
          },
        },
      },
      ...DIMENSIONS,
    },
  },

  CourseCover: {
    still: true,
    output: "Still course cover image",
    props: {
      theme: BRAND_THEME,
      logo: { type: "string" },
      eyebrow: { type: "string" },
      title: { type: "string", required: true },
      subtitle: { type: "string" },
    },
  },

  LessonVideo: {
    output: "Lesson: intro card, footage with burned-in captions, outro card",
    props: {
      theme: BRAND_THEME,
      logo: { type: "string" },
      moduleTitle: { type: "string", required: true },
      lessonNumber: { type: "integer", required: true, min: 1 },
      lessonTitle: { type: "string", required: true },
      videoSrc: { type: "string", required: true },
      captions: { type: "array", of: WORD_CAPTION, required: true },
      clipSeconds: { type: "number", required: true, min: 0, exclusiveMin: true },
      introSeconds: { type: "number", min: 0 },
      outroSeconds: { type: "number", min: 0 },
      outroEyebrow: { type: "string" },
      outroTitle: { type: "string" },
      wordsPerPage: { type: "integer", min: 1 },
      ...DIMENSIONS,
    },
  },

  MicroClip: {
    output: "Vertical clip: footage in a framed 9:16 layout with large captions",
    props: {
      theme: BRAND_THEME,
      logo: { type: "string" },
      hook: { type: "string" },
      videoSrc: { type: "string", required: true },
      captions: { type: "array", of: WORD_CAPTION, required: true },
      clipSeconds: { type: "number", required: true, min: 0, exclusiveMin: true },
      wordsPerPage: { type: "integer", min: 1 },
      ...DIMENSIONS,
    },
  },

  CaptionedShort: {
    output: "Caption-first short: your voiceover audio with burned-in word captions",
    props: {
      theme: BRAND_THEME,
      logo: { type: "string" },
      eyebrow: { type: "string" },
      audio: { type: "string", required: true },
      captions: { type: "array", of: WORD_CAPTION, required: true },
      wordsPerPage: { type: "integer", min: 1 },
      ...DIMENSIONS,
    },
  },

  SplicedShort: {
    output: "9:16 short spliced from several takes: reframe, punch-ins, captions, cutaway scenes",
    props: {
      theme: SPLICED_THEME,
      // Frame ranges from engine/pipeline/splice-plan.mjs, played end to end.
      segments: {
        type: "array",
        minLength: 1,
        required: true,
        of: {
          type: "object",
          fields: {
            src: { type: "string", required: true },
            fromFrame: { type: "integer", required: true, min: 0 },
            toFrame: { type: "integer", required: true, min: 1 },
            centerX: { type: "number", min: 0, max: 1 },
            zoom: { type: "number", min: 0, exclusiveMin: true },
            volume: { type: "number", min: 0 },
          },
        },
      },
      sourceWidth: { type: "integer", min: 16 },
      sourceHeight: { type: "integer", min: 16 },
      baseZoom: { type: "number", min: 0, exclusiveMin: true },
      baseOriginY: { type: "number", min: 0, max: 1 },
      drift: { type: "number", min: 0, max: 0.5 },
      punchIns: {
        type: "array",
        of: {
          type: "object",
          fields: {
            atMs: { type: "number", required: true, min: 0 },
            durMs,
            scale: { type: "number", required: true, min: 1 },
            ramp: { type: "enum", values: ["cut", "ease"] },
            anchorX: { type: "number", min: 0, max: 1 },
            anchorY: { type: "number", min: 0, max: 1 },
            whoosh: { type: "boolean" },
          },
        },
      },
      captions: {
        type: "array",
        of: {
          type: "object",
          fields: {
            word: { type: "string", required: true, allowEmpty: true },
            startMs: { type: "number", required: true, min: 0 },
            endMs: { type: "number", required: true, min: 0 },
            emphasis: { type: "boolean" },
          },
        },
      },
      captionY: { type: "number", min: 0 },
      wordsPerPage: { type: "integer", min: 1 },
      // Per-type content (messages, items, crop, url) is the .tsx type's contract. This checks
      // the fields every cutaway's timing depends on.
      cutaways: {
        type: "array",
        of: {
          type: "object",
          fields: {
            type: {
              type: "enum",
              values: ["title", "chat", "checklist", "overload", "clip", "stat", "cta", "quote"],
              required: true,
            },
            atMs: { type: "number", required: true, min: 0 },
            durMs,
            whoosh: { type: "boolean" },
            captionY: { type: "number", min: 0 },
            hideCaptions: { type: "boolean" },
          },
        },
      },
      kickers: {
        type: "array",
        of: {
          type: "object",
          fields: {
            atMs: { type: "number", required: true, min: 0 },
            durMs,
            text: { type: "string", required: true },
            y: { type: "number", min: 0 },
            rotate: { type: "number" },
          },
        },
      },
      nameTag: {
        type: "object",
        fields: {
          name: { type: "string", required: true },
          title: { type: "string" },
          atMs: { type: "number", required: true, min: 0 },
          durMs,
        },
      },
      sfx: {
        type: "array",
        of: {
          type: "object",
          fields: {
            src: { type: "string", required: true },
            atMs: { type: "number", required: true, min: 0 },
            volume: { type: "number", min: 0 },
          },
        },
      },
      whooshSrc: { type: "string" },
      whooshVolume: { type: "number", min: 0, max: 1 },
      tailMs: { type: "number", min: 0, max: 60000 },
      // Optional portrait layout band, as fractions of the frame height. No preset exists.
      safeArea: {
        type: "object",
        fields: {
          top: { type: "number", min: 0, max: 1 },
          bottom: { type: "number", min: 0, max: 1 },
        },
      },
      ...DIMENSIONS,
    },
  },
};

/** Composition ids, in the order they appear in the generated docs. */
export const COMPOSITION_IDS = Object.keys(COMPOSITIONS);
