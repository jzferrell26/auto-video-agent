import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { slugSchema, mapSchema, wordsSchema, shortSchema, rebaseWords, outputDirectory } from "../engine/pipeline/runtime.mjs";
import { buildCoursePayload, checkedJson, deliver } from "../engine/pipeline/ghl-publish-complete.mjs";
import { inspectFile } from "../scripts/check-hygiene.mjs";

describe("job boundaries", () => {
  test.each(["../outside", "a/b", "a\\b", ".", "", "-flag", "a b", "x".repeat(65)])("rejects unsafe slug %s", (slug) => {
    expect(() => slugSchema.parse(slug)).toThrow();
  });
  test("accepts a portable slug", () => expect(slugSchema.parse("lesson-01_test")).toBe("lesson-01_test"));
  const lesson = { number: 1, title: "Demo", inSec: 0, outSec: 3 };
  test("rejects inverted lesson ranges", () => expect(() => mapSchema.parse({ module: "Demo", lessons: [{ ...lesson, outSec: -1 }] })).toThrow());
  test("rejects duplicate lesson numbers", () => expect(() => mapSchema.parse({ module: "Demo", lessons: [lesson, lesson] })).toThrow());
  test("rejects invalid words", () => expect(() => wordsSchema.parse([{ word: "demo", startMs: 200, endMs: 100 }] )).toThrow());
  test("requires a valid nonempty brief", () => expect(() => shortSchema.parse({ scenes: [] })).toThrow());
  test("rejects output outside repo", () => expect(() => outputDirectory("../outside")).toThrow());
  test("rebases words and clips tails to the retained interval", () => {
    expect(rebaseWords([
      { word: "before", startMs: 0, endMs: 999 }, { word: "kept", startMs: 1000, endMs: 3500 },
      { word: "after", startMs: 3000, endMs: 4000 },
    ], 1, 3)).toEqual([{ word: "kept", startMs: 0, endMs: 2000 }]);
  });
});

describe("external delivery safety", () => {
  test("forces draft visibility even if a supplied post says published", () => {
    const payload = buildCoursePayload({ module: "Demo", instructor: { name: "Demo" }, courseTitle: "Demo" }, "example", "https://example.com/cover.png", [{ title: "Demo", visibility: "published" }]);
    expect(payload.products[0].categories[0].visibility).toBe("draft");
    expect(payload.products[0].categories[0].posts[0].visibility).toBe("draft");
  });
  test("dry run never calls fetch or needs credentials", async () => {
    const request = vi.fn(() => { throw new Error("Unexpected network"); });
    vi.stubGlobal("fetch", request);
    try {
      await deliver(["engine/examples/demo-course.json", "demo"]);
      expect(request).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  test("rejects unknown delivery flags", async () => {
    await expect(deliver(["engine/examples/demo-course.json", "demo", "--publish"])).rejects.toThrow();
  });
  test("HTTP failure does not echo a provider response", async () => {
    await expect(checkedJson(new Response("private provider response", { status: 403 }), z.object({}), "Upload")).rejects.toThrow("HTTP 403");
  });
  test("malformed success cannot masquerade as accepted delivery", async () => {
    await expect(checkedJson(new Response("{}"), z.object({ url: z.string() }), "Upload")).rejects.toThrow("unexpected response");
  });
});

describe("repository hygiene", () => {
  test.each([".env", "folder/.env.local", "public/image.png", "brand-props/job.json", "_sources/file.txt", "key.pem", "x.transcript.txt", "lesson.words.json"])("rejects private artifact %s", (path) => {
    expect(inspectFile(path, "")).not.toEqual([]);
  });
  test("allows empty example environment", () => expect(inspectFile(".env.example", "GHL_PIT=\nGHL_LOCATION_ID=\n")).toEqual([]));
  test("rejects filled example environment", () => expect(inspectFile(".env.example", "GHL_PIT=example\n")).not.toEqual([]));
  test("detects token-shaped material using an invented fixture", () => {
    expect(inspectFile("demo.txt", "ghp_" + "x".repeat(36))).toContain("token-shaped value");
  });
  test("allows normal attribution", () => expect(inspectFile("LICENSE", "Copyright (c) 2026 Project contributor")).toEqual([]));
});
