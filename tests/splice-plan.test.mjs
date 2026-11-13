import assert from "node:assert/strict";
import { test } from "vitest";

import { buildSplicePlan, toOutputMs, wordAt } from "../engine/pipeline/splice-plan.mjs";

const words = (list) => list.map(([word, startMs, endMs]) => ({ word, startMs, endMs }));

const takes = {
  a: {
    src: "take-a.mp4",
    words: words([
      ["so", 4600, 4950],
      ["Rockets", 5100, 5780],
      ["launch", 5780, 6060],
      ["today.", 10000, 10480],
      ["Next", 10980, 11120],
    ]),
  },
  b: {
    src: "take-b.mp4",
    words: words([
      ["today", 27860, 28240],
      ["Hello", 28420, 28560],
      ["world,", 28560, 28900],
      ["finished.", 31440, 31660],
    ]),
  },
};

test("snaps ranges to the frame grid and lays segments end to end", () => {
  const plan = buildSplicePlan({
    fps: 30,
    takes,
    segments: [
      { take: "a", inMs: 5067, outMs: 10667, zoom: 1 },
      { take: "b", inMs: 28333, outMs: 31767 },
    ],
  });
  assert.deepEqual(
    plan.segments.map(({ src, fromFrame, toFrame, outFrom, durationInFrames }) => [src, fromFrame, toFrame, outFrom, durationInFrames]),
    [
      ["take-a.mp4", 152, 320, 0, 168],
      ["take-b.mp4", 850, 953, 168, 103],
    ]
  );
  assert.equal(plan.durationInFrames, 271);
  assert.equal(plan.segments[0].zoom, 1, "editorial extras ride along on the segment");
  assert.equal("inMs" in plan.segments[0], false, "raw ms are replaced by frames");
});

test("keeps only words whose midpoint survives the cut, retimed to output time", () => {
  const plan = buildSplicePlan({
    fps: 30,
    takes,
    segments: [
      { take: "a", inMs: 5067, outMs: 10667 },
      { take: "b", inMs: 28333, outMs: 31767 },
    ],
  });
  assert.deepEqual(
    plan.captions.map((w) => w.word),
    ["Rockets", "launch", "today.", "Hello", "world,", "finished."],
    "'so' and 'Next' are outside segment 1; 'today' ends before segment 2 starts"
  );
  const first = plan.captions[0];
  assert.equal(first.startMs, 33, "5100ms lands 33ms after the 5066.7ms in-point");
  const hello = plan.captions[3];
  assert.equal(hello.startMs, 5687, "segment 2 starts at output frame 168 = 5600ms");
});

test("drops a word with NaN timing instead of captioning it", () => {
  const plan = buildSplicePlan({
    fps: 30,
    takes: { a: { src: "a.mp4", words: [{ word: "ghost", startMs: Number.NaN, endMs: 500 }] } },
    segments: [{ take: "a", inMs: 0, outMs: 1000 }],
  });
  assert.deepEqual(plan.captions, []);
});

test("clamps a word that overhangs the out-point to the segment end", () => {
  const plan = buildSplicePlan({
    fps: 30,
    takes: { a: { src: "a.mp4", words: words([["long", 900, 1300]]) } },
    segments: [{ take: "a", inMs: 0, outMs: 1200 }],
  });
  assert.deepEqual(plan.captions, [{ word: "long", startMs: 900, endMs: 1200, segment: 0 }]);
});

test("rejects unknown takes, empty ranges, and bad fps", () => {
  assert.throws(() => buildSplicePlan({ fps: 30, takes, segments: [{ take: "z", inMs: 0, outMs: 1000 }] }), /unknown take/);
  assert.throws(() => buildSplicePlan({ fps: 30, takes, segments: [{ take: "a", inMs: 1000, outMs: 1010 }] }), /empty/);
  assert.throws(() => buildSplicePlan({ fps: 30, takes, segments: [{ take: "a", inMs: 2000, outMs: 1000 }] }), /empty/);
  assert.throws(() => buildSplicePlan({ fps: 29.97, takes, segments: [{ take: "a", inMs: 0, outMs: 1000 }] }), /fps/);
  assert.throws(() => buildSplicePlan({ fps: 30, takes, segments: [] }), /non-empty/);
  assert.throws(() => buildSplicePlan({ fps: 30, takes, segments: [{ take: "a", inMs: Number.NaN, outMs: 1000 }] }), /finite/);
});

test("maps a source moment to output time and refuses moments that were cut", () => {
  const plan = buildSplicePlan({
    fps: 30,
    takes,
    segments: [
      { take: "a", inMs: 5067, outMs: 10667 },
      { take: "b", inMs: 28333, outMs: 31767 },
    ],
  });
  // Segment 2 starts at output 5600ms, and its in-point snapped to frame 850 (28333.3ms).
  assert.equal(toOutputMs(plan, 1, 30260), Math.round(5600 + (30260 - 28333.333)));
  assert.throws(() => toOutputMs(plan, 0, 11000), /outside the kept range/);
  assert.throws(() => toOutputMs(plan, 5, 0), /no segment/);
});

test("finds the nth spoken word in a segment, ignoring case and punctuation", () => {
  const plan = buildSplicePlan({
    fps: 30,
    takes: {
      a: { src: "a.mp4", words: words([["Alpha", 100, 300], ["beta,", 300, 600], ["alpha.", 800, 1000]]) },
    },
    segments: [{ take: "a", inMs: 0, outMs: 1500 }],
  });
  assert.equal(wordAt(plan, 0, "alpha").startMs, 100);
  assert.equal(wordAt(plan, 0, "ALPHA", 2).startMs, 800);
  assert.equal(wordAt(plan, 0, "beta").word, "beta,");
  assert.throws(() => wordAt(plan, 0, "alpha", 3), /not found/);
});

test("finds the first word of a segment that starts at a fractional millisecond", () => {
  // Segment 1 is 31 frames, so segment 2 starts at 1033.3ms. Its first word starts 10ms
  // before the in-point, is clamped to 1033.3ms, and rounds to 1033ms, below the boundary.
  const plan = buildSplicePlan({
    fps: 30,
    takes: { a: { src: "a.mp4", words: words([["alpha", 100, 300], ["beta", 1990, 2300], ["gamma", 2400, 2700]]) } },
    segments: [
      { take: "a", inMs: 0, outMs: 1033 },
      { take: "a", inMs: 2000, outMs: 3000 },
    ],
  });
  assert.equal(plan.segments[1].outFrom, 31);
  assert.equal(wordAt(plan, 1, "beta").startMs, 1033);
  assert.equal(wordAt(plan, 1, "gamma").startMs, 1433);
  assert.throws(() => wordAt(plan, 0, "beta"), /not found/, "a word is only found in its own segment");
});
