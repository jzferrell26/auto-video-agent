import { test } from "vitest";
import assert from "node:assert/strict";
import { usageText } from "../engine/pipeline/runtime.mjs";

test("usage text comes from a script's own Usage header", () => {
  const text = usageText(new URL("../engine/pipeline/master-audio.mjs", import.meta.url).href);
  assert.ok(text?.startsWith("Usage:"));
  assert.ok(text.includes("npm run master:audio"));
});

test("a script without a Usage header returns null", () => {
  assert.equal(usageText(new URL("../engine/pipeline/runtime.mjs", import.meta.url).href), null);
});
