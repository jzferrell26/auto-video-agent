// Keeps engine/compositions.mjs honest against the real prop types in engine/remotion/*.tsx
// and against the docs generated from it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { COMPOSITIONS, COMPOSITION_IDS } from "../engine/compositions.mjs";
import { ROOT } from "../engine/pipeline/runtime.mjs";
import { generatedBlock, spliceBlock } from "../engine/pipeline/gen-docs.mjs";

/** Top-level keys of `export type <Name>Props = { ... }` in a component file. */
function propKeys(file, typeName) {
  const text = readFileSync(resolve(ROOT, "engine/remotion", file), "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("export type " + typeName + " = {");
  if (start === -1) throw new Error("type not found: " + typeName);
  const body = text.slice(start).split("\n").slice(1);
  const keys = [];
  for (const line of body) {
    if (line.startsWith("}")) break;
    const match = /^ {2}([A-Za-z0-9_]+)\??:/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys.sort();
}

const SOURCES = {
  BrandedShort: ["BrandedShort.tsx", "BrandedShortProps"],
  CourseCover: ["CourseCover.tsx", "CourseCoverProps"],
  LessonVideo: ["LessonVideo.tsx", "LessonVideoProps"],
  MicroClip: ["MicroClip.tsx", "MicroClipProps"],
  CaptionedShort: ["CaptionedShort.tsx", "CaptionedShortProps"],
  SplicedShort: ["SplicedShort.tsx", "SplicedShortProps"],
};

describe("composition registry", () => {
  test("lists exactly the public compositions", () => {
    expect([...COMPOSITION_IDS].sort()).toEqual(Object.keys(SOURCES).sort());
  });
  test.each(Object.entries(SOURCES))("%s props match its .tsx type", (id, [file, type]) => {
    expect(Object.keys(COMPOSITIONS[id].props).sort()).toEqual(propKeys(file, type));
  });
  test("every composition is registered in src/Root.tsx", () => {
    const root = readFileSync(resolve(ROOT, "src/Root.tsx"), "utf8");
    for (const id of COMPOSITION_IDS) expect(root).toContain('id="' + id + '"');
  });
});

describe("generated docs", () => {
  test("engine/README.md holds the current generated block", () => {
    const current = readFileSync(resolve(ROOT, "engine/README.md"), "utf8");
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    expect(spliceBlock(current, generatedBlock().replaceAll("\n", eol))).toBe(current);
  });
  test("splicing needs both markers in order", () => {
    expect(() => spliceBlock("no markers", "x")).toThrow("generated-block markers");
  });
  test("block mentions every composition and uses no non-ASCII dashes", () => {
    const block = generatedBlock();
    for (const id of COMPOSITION_IDS) expect(block).toContain("`" + id + "`");
    expect(block).not.toMatch(/[\u2013\u2014]/);
  });
});
