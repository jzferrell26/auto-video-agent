import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { REPO_ROOT, findRepoRoot } from "../engine/pipeline/paths.mjs";
import { ROOT, assertInsideRoot } from "../engine/pipeline/runtime.mjs";

const scratch = [];
afterEach(() => { while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true }); });
const makeProject = () => {
  const base = mkdtempSync(join(tmpdir(), "paths-test-"));
  scratch.push(base);
  writeFileSync(join(base, "package.json"), "{}");
  const deep = join(base, "engine", "pipeline", "nested");
  mkdirSync(deep, { recursive: true });
  return { base, deep };
};

describe("repository root", () => {
  test("is the folder holding package.json and src/index.tsx", () => {
    expect(REPO_ROOT).toBe(resolve(import.meta.dirname, ".."));
    expect(ROOT).toBe(REPO_ROOT);
  });
  test("is found by walking up, not by counting hops", () => {
    const { base, deep } = makeProject();
    expect(findRepoRoot(deep)).toBe(base);
    expect(findRepoRoot(base)).toBe(base);
  });
  test("gives up after the hop limit with a clear message", () => {
    const { deep } = makeProject();
    // The only package.json sits three levels above, so a limit of 1 must fail.
    expect(() => findRepoRoot(deep, 1)).toThrow("Could not locate the repository root");
  });
});

describe("assertInsideRoot", () => {
  test("accepts relative and absolute paths inside the repository", () => {
    expect(assertInsideRoot("out/final.mp4")).toBe(resolve(ROOT, "out/final.mp4"));
    expect(assertInsideRoot(resolve(ROOT, "out", "x.mp4"))).toBe(resolve(ROOT, "out", "x.mp4"));
  });
  test.each(["../outside.mp4", "out/../../outside.mp4", "", "."])("rejects %j", (path) => {
    expect(() => assertInsideRoot(path)).toThrow("inside the repository");
  });
  test("rejects an absolute path elsewhere", () => {
    expect(() => assertInsideRoot(join(tmpdir(), "elsewhere.mp4"), "Input")).toThrow("Input must be inside");
  });
});
