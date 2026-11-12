// Locks the prop-validation contract.
import { test } from "vitest";
import assert from "node:assert/strict";
import { validateProps, assertValidProps } from "../engine/pipeline/validate-props.mjs";

const lesson = (over = {}) => ({
  moduleTitle: "Module One",
  lessonNumber: 1,
  lessonTitle: "Getting started",
  videoSrc: "lessons/m1-L01.mp4",
  captions: [{ word: "hello", startMs: 0, endMs: 400 }],
  clipSeconds: 92.5,
  ...over,
});

test("accepts a valid LessonVideo props object", () => {
  assert.deepEqual(validateProps("LessonVideo", lesson()), []);
});

test("rejects NaN clipSeconds — the ffprobe failure mode", () => {
  const errors = validateProps("LessonVideo", lesson({ clipSeconds: NaN }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /clipSeconds/);
  assert.match(errors[0], /finite number/);
  assert.match(errors[0], /NaN/);
});

test("rejects Infinity as well as NaN", () => {
  const errors = validateProps("LessonVideo", lesson({ clipSeconds: Infinity }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /finite number/);
});

test("rejects a zero-length clip (exclusive minimum)", () => {
  const errors = validateProps("LessonVideo", lesson({ clipSeconds: 0 }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be > 0/);
});

test("reports a missing required prop by name", () => {
  const { lessonTitle, ...props } = lesson();
  const errors = validateProps("LessonVideo", props);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lessonTitle: required/);
});

test("treats null like missing, not like a value", () => {
  const errors = validateProps("LessonVideo", lesson({ lessonTitle: null }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lessonTitle: required/);
});

test("rejects an empty string for a required string", () => {
  const errors = validateProps("LessonVideo", lesson({ lessonTitle: "" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /non-empty string/);
});

test("rejects a non-integer lessonNumber", () => {
  const errors = validateProps("LessonVideo", lesson({ lessonNumber: 1.5 }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lessonNumber: expected an integer/);
});

test("validates nested caption items and reports the index", () => {
  const errors = validateProps(
    "LessonVideo",
    lesson({ captions: [{ word: "ok", startMs: 0, endMs: 10 }, { word: "bad", startMs: "0", endMs: 10 }] })
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /captions\.1\.startMs/);
});

test("flags a typo'd prop name rather than ignoring it", () => {
  const errors = validateProps("LessonVideo", lesson({ wordsPerPag: 4 }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /wordsPerPag: not a prop of LessonVideo/);
});

test("accepts optional props when omitted", () => {
  assert.deepEqual(validateProps("LessonVideo", lesson({ theme: { gold: "#fff" }, logo: "logo.png" })), []);
});

test("collects multiple errors in one pass", () => {
  const errors = validateProps("LessonVideo", lesson({ clipSeconds: NaN, lessonNumber: 0 }));
  assert.equal(errors.length, 2);
});

test("rejects an unknown composition and lists the known ones", () => {
  const errors = validateProps("NoSuchComposition", {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown composition/);
  assert.match(errors[0], /LessonVideo/);
});

test("rejects a non-object props value", () => {
  assert.match(validateProps("LessonVideo", null)[0], /expected an object/);
  assert.match(validateProps("LessonVideo", "nope")[0], /expected an object/);
});

test("BrandedShort requires a non-empty scenes array with valid scene types", () => {
  assert.deepEqual(
    validateProps("BrandedShort", { scenes: [{ type: "intro", headline: "Hi", seconds: 3 }] }),
    []
  );

  const empty = validateProps("BrandedShort", { scenes: [] });
  assert.equal(empty.length, 1);
  assert.match(empty[0], /at least 1 item/);

  const badType = validateProps("BrandedShort", { scenes: [{ type: "bogus", seconds: 3 }] });
  assert.equal(badType.length, 1);
  assert.match(badType[0], /scenes\.0\.type: expected one of/);

  const badSeconds = validateProps("BrandedShort", { scenes: [{ type: "intro", seconds: NaN }] });
  assert.equal(badSeconds.length, 1);
  assert.match(badSeconds[0], /scenes\.0\.seconds/);
});

test("assertValidProps throws with every problem listed", () => {
  assert.throws(
    () => assertValidProps("LessonVideo", lesson({ clipSeconds: NaN, lessonNumber: 0 })),
    /** @param {Error} err */
    (err) => {
      assert.match(err.message, /Invalid props for LessonVideo \(2 problems\)/);
      assert.match(err.message, /clipSeconds/);
      assert.match(err.message, /lessonNumber/);
      return true;
    }
  );
});

test("assertValidProps is silent on valid props", () => {
  assert.doesNotThrow(() => assertValidProps("LessonVideo", lesson()));
});

test("MicroClip and CaptionedShort check their required media props", () => {
  const captions = [{ word: "hi", startMs: 0, endMs: 100 }];
  assert.deepEqual(validateProps("MicroClip", { videoSrc: "a.mp4", captions, clipSeconds: 5, hook: "Hi" }), []);
  assert.match(validateProps("MicroClip", { captions, clipSeconds: 5 })[0], /videoSrc: required/);
  assert.deepEqual(validateProps("CaptionedShort", { audio: "a.wav", captions }), []);
  assert.match(validateProps("CaptionedShort", { captions })[0], /audio: required/);
});

test("CourseCover needs a title and BrandedShort needs timed scenes", () => {
  assert.deepEqual(validateProps("CourseCover", { title: "Demo" }), []);
  assert.match(validateProps("CourseCover", {})[0], /title: required/);
});

test("SplicedShort accepts a minimal brief, with or without a safe area", () => {
  const spliced = (over = {}) => ({
    segments: [{ src: "take.mp4", fromFrame: 0, toFrame: 90 }],
    cutaways: [{ type: "quote", atMs: 500, durMs: 2000, quote: "Example text." }],
    ...over,
  });
  assert.deepEqual(validateProps("SplicedShort", spliced()), []);
  assert.deepEqual(validateProps("SplicedShort", spliced({ safeArea: { top: 0.1, bottom: 0.7 } })), []);
  const errors = validateProps("SplicedShort", spliced({ safeArea: { top: 2, bottom: -1 } }));
  assert.equal(errors.length, 2);
});

test("SplicedShort rejects empty segments, bad cutaway timing and a stray prop", () => {
  assert.match(validateProps("SplicedShort", { segments: [] })[0], /at least 1 item/);
  const timing = validateProps("SplicedShort", {
    segments: [{ src: "t.mp4", fromFrame: 0, toFrame: 30 }],
    cutaways: [{ type: "title", atMs: 0, durMs: 0 }],
  });
  assert.match(timing.join("\n"), /cutaways\.0\.durMs/);
  assert.match(validateProps("SplicedShort", { segments: [{ src: "t.mp4", fromFrame: 0, toFrame: 30 }], whoosh: "a.wav" })[0], /not a prop of SplicedShort/);
});

test("props of removed or private compositions are an unknown composition", () => {
  assert.match(validateProps("TalkingHead", {})[0], /unknown composition/);
});

test("a blank caption word is allowed, because transcripts can contain one", () => {
  assert.deepEqual(validateProps("CaptionedShort", { audio: "a.wav", captions: [{ word: "", startMs: 0, endMs: 10 }] }), []);
});
