// Locks the archive contract: a source is removed only after a verified copy exists.
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveFiles, expandInputs, parseArgs, projectFolderName, readEnvValue } from "../engine/pipeline/archive.mjs";

const setup = async () => {
  const base = await mkdtemp(join(tmpdir(), "archive-test-"));
  const work = join(base, "work");
  const root = join(base, "archive");
  await mkdir(work);
  await mkdir(root);
  const file = join(work, "final.mp4");
  await writeFile(file, Buffer.alloc(4096, 7));
  return { base, work, root, file, done: () => rm(base, { recursive: true, force: true }) };
};

test("moves a finished file into the project folder and removes the source", async () => {
  const t = await setup();
  const [r] = await archiveFiles({ files: [t.file], root: t.root, project: "Spring Ads" });
  assert.equal(r.status, "moved");
  assert.equal(existsSync(t.file), false);
  assert.deepEqual(await readFile(join(t.root, "Spring Ads", "final.mp4")), Buffer.alloc(4096, 7));
  await t.done();
});

test("--keep copies without removing the source", async () => {
  const t = await setup();
  const [r] = await archiveFiles({ files: [t.file], root: t.root, project: "P", keep: true });
  assert.equal(r.status, "copied");
  assert.equal(existsSync(t.file), true);
  await t.done();
});

test("refuses a missing or relative archive folder and names the fix", async () => {
  const t = await setup();
  await assert.rejects(
    archiveFiles({ files: [t.file], root: join(t.base, "nope"), project: "P" }),
    /archive folder not found.*VIDEO_ARCHIVE_DIR.*Drive for desktop/s
  );
  await assert.rejects(archiveFiles({ files: [t.file], root: undefined, project: "P" }), /\(unset\)/);
  await assert.rejects(archiveFiles({ files: [t.file], root: "relative/dir", project: "P" }), /absolute path/);
  assert.equal(existsSync(t.file), true);
  await t.done();
});

test("a bad copy keeps the source and leaves nothing in the archive", async () => {
  const t = await setup();
  const shortCopy = async (_src, dest) => writeFile(dest, Buffer.alloc(10));
  const [r] = await archiveFiles({ files: [t.file], root: t.root, project: "P", copy: shortCopy });
  assert.equal(r.status, "failed");
  assert.match(r.error, /source kept/);
  assert.equal(existsSync(t.file), true);
  assert.equal(existsSync(join(t.root, "P", "final.mp4")), false);
  await t.done();
});

test("a copy that dies partway leaves nothing behind and a retry works", async () => {
  const t = await setup();
  const dyingCopy = async (_src, dest) => {
    await writeFile(dest, Buffer.alloc(100));
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };
  const [r] = await archiveFiles({ files: [t.file], root: t.root, project: "P", copy: dyingCopy });
  assert.equal(r.status, "failed");
  assert.equal(existsSync(t.file), true);
  assert.equal(existsSync(join(t.root, "P", "final.mp4")), false);
  const [retry] = await archiveFiles({ files: [t.file], root: t.root, project: "P" });
  assert.equal(retry.status, "moved");
  await t.done();
});

test("a folder already sitting at the destination name is refused", async () => {
  const t = await setup();
  await mkdir(join(t.root, "P", "final.mp4"), { recursive: true });
  const [r] = await archiveFiles({ files: [t.file], root: t.root, project: "P" });
  assert.equal(r.status, "failed");
  assert.match(r.error, /folder with this name/);
  assert.equal(existsSync(t.file), true);
  await t.done();
});

test("the same file named twice is archived once", async () => {
  const t = await setup();
  assert.equal((await expandInputs([t.file, t.file])).length, 1);
  await t.done();
});

test("a same-size copy with different bytes is caught by the hash", async () => {
  const t = await setup();
  const corruptCopy = async (_src, dest) => writeFile(dest, Buffer.alloc(4096, 9));
  const [r] = await archiveFiles({ files: [t.file], root: t.root, project: "P", copy: corruptCopy });
  assert.equal(r.status, "failed");
  assert.equal(existsSync(t.file), true);
  assert.equal(existsSync(join(t.root, "P", "final.mp4")), false);
  await t.done();
});

test("an identical file already archived is not copied again; a different one is never overwritten", async () => {
  const t = await setup();
  await mkdir(join(t.root, "P"));
  await writeFile(join(t.root, "P", "final.mp4"), Buffer.alloc(4096, 7));
  const [same] = await archiveFiles({ files: [t.file], root: t.root, project: "P" });
  assert.equal(same.status, "already archived");
  assert.equal(existsSync(t.file), false);

  // Same size, different content: refused, both files untouched.
  await writeFile(t.file, Buffer.alloc(4096, 1));
  const [clash] = await archiveFiles({ files: [t.file], root: t.root, project: "P" });
  assert.equal(clash.status, "failed");
  assert.match(clash.error, /already archived/);
  assert.equal(existsSync(t.file), true);
  assert.deepEqual(await readFile(join(t.root, "P", "final.mp4")), Buffer.alloc(4096, 7));
  await t.done();
});

test("a file that already lives in the archive is never deleted", async () => {
  const t = await setup();
  await mkdir(join(t.root, "P"));
  const inside = join(t.root, "P", "final.mp4");
  await writeFile(inside, Buffer.alloc(64, 3));
  const [r] = await archiveFiles({ files: [inside], root: t.root, project: "P" });
  assert.equal(r.status, "skipped");
  assert.equal(existsSync(inside), true);
  await t.done();
});

test("a source that changes during the archive is kept", async () => {
  const t = await setup();
  const raceCopy = async (src, dest, mode) => {
    await copyFile(src, dest, mode);
    await appendFile(src, "re-rendered");
  };
  const [r] = await archiveFiles({ files: [t.file], root: t.root, project: "P", copy: raceCopy });
  assert.equal(r.status, "failed");
  assert.match(r.error, /source changed/);
  assert.equal(existsSync(t.file), true);
  await t.done();
});

test("project names become one safe folder name", () => {
  assert.equal(projectFolderName('Ads: "Spring" 1/2'), "Ads- -Spring- 1-2");
  assert.equal(projectFolderName("  Demo short. "), "Demo short");
  assert.equal(projectFolderName("../escape"), "-escape");
  assert.throws(() => projectFolderName(""), /--project needs a name/);
  assert.throws(() => projectFolderName("NUL"), /reserved/);
  assert.throws(() => projectFolderName("com1.txt"), /reserved/);
});

test("only videos and caption or text deliverables are accepted; folders need --folder", async () => {
  const t = await setup();
  await writeFile(join(t.work, ".env"), "SECRET=1");
  await writeFile(join(t.work, "notes.txt"), "x");
  await writeFile(join(t.work, "cut.MOV"), "x");
  await mkdir(join(t.work, "nested"));
  await writeFile(join(t.work, "nested", "deep.mp4"), "x");
  await assert.rejects(expandInputs([join(t.work, ".env")]), /not a video/);
  assert.equal((await expandInputs([join(t.work, "notes.txt")])).length, 1);
  await assert.rejects(expandInputs([t.work]), /pass --folder/);
  const files = (await expandInputs([t.work], { folder: true })).map((f) => f.slice(t.work.length + 1)).sort();
  assert.deepEqual(files, ["cut.MOV", "final.mp4"]);
  await t.done();
});

test("a flag that needs a value refuses another flag", () => {
  assert.throws(() => parseArgs(["--project", "--keep", "a.mp4"]), /--project needs a value/);
  assert.throws(() => parseArgs(["--to"]), /--to needs a value/);
  assert.throws(() => parseArgs(["--projct", "x"]), /unknown flag/);
  assert.deepEqual(parseArgs(["--project", "P", "--keep", "a.mp4"]), { inputs: ["a.mp4"], keep: true, folder: false, project: "P" });
});


test("reads only the archive folder from dotenv text", () => {
  const text = 'GHL_PIT=\nVIDEO_ARCHIVE_DIR="/mnt/cloud drive/Videos"\n';
  assert.equal(readEnvValue(text, "VIDEO_ARCHIVE_DIR"), "/mnt/cloud drive/Videos");
  assert.equal(readEnvValue("VIDEO_ARCHIVE_DIR=\n", "VIDEO_ARCHIVE_DIR"), undefined);
  assert.equal(readEnvValue("export VIDEO_ARCHIVE_DIR=/a/b#c\r\n", "VIDEO_ARCHIVE_DIR"), "/a/b#c");
  assert.equal(readEnvValue("OTHER=1\n", "VIDEO_ARCHIVE_DIR"), undefined);
});
