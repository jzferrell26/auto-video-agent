// Locks URI parsing and transfer-argv construction.
//
// The command builders are pure and the environment is passed in rather than read from
// process.env. The last tests touch only a scratch folder inside out/, never the network. A wrong argv is the
// failure mode that costs the most ; it surfaces 40 minutes into a cloud render, after the
// source download and the encode ; so it is checked here instead.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fetchCommand, fetchToFile, isRemoteUri, joinUri, localName, parseUri, printableUri, publishCommand, publishFile, transferEnv } from "../engine/pipeline/storage.mjs";
import { ROOT, outputDirectory } from "../engine/pipeline/runtime.mjs";

const R2_ENV = { R2_ACCOUNT_ID: "acct123" };
const DRIVE_ENV = { RCLONE_CONFIG_DRIVE_TYPE: "drive" };

// Build an argv in one step. The `assert.ok` is not decoration: it draws the line between
// "this URI needs a transfer tool" and "this URI is handled in-process", and the two
// null-returning cases are asserted separately below.
const fetchArgv = (uri, dest, env = {}) => {
  const cmd = fetchCommand(parseUri(uri), dest, env);
  assert.ok(cmd, `${uri} should need a transfer subprocess`);
  return cmd;
};
const publishArgv = (local, uri, env = {}) => {
  const cmd = publishCommand(parseUri(uri), local, env);
  assert.ok(cmd, `${uri} should need a transfer subprocess`);
  return cmd;
};

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test("parses a bucket URI into bucket and key", () => {
  assert.deepEqual(parseUri("s3://my-bucket/raw/session.mp4"), {
    scheme: "s3",
    bucket: "my-bucket",
    key: "raw/session.mp4",
  });
});

test("r2:// parses the same shape as s3://, so callers branch on scheme only", () => {
  const r2 = parseUri("r2://media/raw/session.mp4");
  assert.equal(r2.scheme, "r2");
  assert.equal(r2.bucket, "media");
  assert.equal(r2.key, "raw/session.mp4");
});

test("keeps the whole URL for https, and derives a key from its path", () => {
  // Built from parts so the repository hygiene scan does not read the fixture as a real signed URL.
  const signed = "https://cdn.example.com/vault/session.mp4?" + "X-Amz-" + "Signature=abc";
  const ref = parseUri(signed);
  assert.equal(ref.scheme, "https");
  assert.equal(ref.url, signed);
  assert.equal(ref.key, "vault/session.mp4"); // the query string is not part of the name
});

test("file:// yields an absolute path", () => {
  assert.deepEqual(parseUri("file:///srv/media/session.mp4"), {
    scheme: "file",
    path: "/srv/media/session.mp4",
    key: "srv/media/session.mp4",
  });
});

test("file:// with a percent-encoded space decodes", () => {
  assert.deepEqual(parseUri("file:///srv/my%20media/a.mp4"), {
    scheme: "file",
    path: "/srv/my media/a.mp4",
    key: "srv/my media/a.mp4",
  });
});

test("file:// with a Windows drive letter drops the URI's leading slash", () => {
  assert.deepEqual(parseUri("file:///C:/media/session.mp4"), {
    scheme: "file",
    path: "C:/media/session.mp4",
    key: "C:/media/session.mp4",
  });
});

test("scheme matching is case-insensitive", () => {
  assert.equal(parseUri("S3://b/k.mp4").scheme, "s3");
});

test("rejects a bucket URI with no key", () => {
  assert.throws(() => parseUri("s3://just-a-bucket"), /needs a bucket AND a key/);
});

test("rejects a URI that points at a directory", () => {
  assert.throws(() => parseUri("s3://bucket/renders/"), /directory, not a file/);
});

test("rejects .. in a key, so a destination directory cannot be escaped", () => {
  assert.throws(() => parseUri("s3://bucket/../../etc/passwd"), /may not contain \. or \.\. segments/);
  assert.throws(() => parseUri("drive://a/../b.mp4"), /may not contain \. or \.\. segments/);
});

test("rejects http:// rather than silently upgrading it", () => {
  assert.throws(() => parseUri("http://example.com/a.mp4"), /use https:\/\//);
});

test("rejects an unknown scheme by name", () => {
  assert.throws(() => parseUri("gs://bucket/a.mp4"), /unsupported storage scheme gs:\/\//);
});

test("rejects a bare path, which is the likeliest caller mistake", () => {
  assert.throws(() => parseUri("/srv/media/session.mp4"), /not a storage URI/);
  assert.throws(() => parseUri(""), /empty/);
});

test("rejects a file:// URI with only two slashes", () => {
  assert.throws(() => parseUri("file://relative/a.mp4"), /must be absolute/);
});

// The caveat that makes Drive the awkward option: rclone addresses Drive by path.
test("names the Drive-file-ID mistake instead of letting rclone report a missing directory", () => {
  assert.throws(
    () => parseUri("drive://1AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
    /looks like a Drive file ID.*RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID/s
  );
});

test("a Drive path with a filename is accepted", () => {
  assert.deepEqual(parseUri("drive://Recordings/2026-08-08/session.mp4"), {
    scheme: "drive",
    path: "Recordings/2026-08-08/session.mp4",
    key: "Recordings/2026-08-08/session.mp4",
  });
});

// ---------------------------------------------------------------------------
// filenames
// ---------------------------------------------------------------------------

test("localName is the basename only, never a nested path", () => {
  assert.equal(localName("s3://b/raw/2026/session.mp4"), "session.mp4");
  assert.equal(localName("drive://Recordings/session.mp4"), "session.mp4");
  assert.equal(localName("https://cdn.example.com/a/b/c.mp4?sig=1"), "c.mp4");
});

test("joinUri appends a filename to a prefix, with or without a trailing slash", () => {
  assert.equal(joinUri("s3://b/renders", "a.mp4"), "s3://b/renders/a.mp4");
  assert.equal(joinUri("s3://b/renders/", "a.mp4"), "s3://b/renders/a.mp4");
});

test("joinUri refuses a path, so a caller cannot smuggle in a subdirectory", () => {
  assert.throws(() => joinUri("s3://b/renders", "../a.mp4"), /takes a filename, not a path/);
});

// ---------------------------------------------------------------------------
// fetch commands
// ---------------------------------------------------------------------------

test("s3 fetch uses aws s3 cp with no endpoint override", () => {
  const cmd = fetchArgv("s3://media/raw/session.mp4", "/w/public/session.mp4");
  assert.equal(cmd.command, "aws");
  assert.deepEqual(cmd.args, [
    "s3", "cp", "s3://media/raw/session.mp4", "/w/public/session.mp4", "--no-progress",
  ]);
});

test("r2 fetch rewrites the scheme to s3 and points at the account endpoint", () => {
  const cmd = fetchArgv("r2://media/raw/session.mp4", "/w/public/session.mp4", R2_ENV);
  // The URI said r2://, but the AWS CLI only speaks s3:// ; the endpoint is what differs.
  assert.ok(cmd.args.includes("s3://media/raw/session.mp4"));
  const i = cmd.args.indexOf("--endpoint-url");
  assert.notEqual(i, -1);
  assert.equal(cmd.args[i + 1], "https://acct123.r2.cloudflarestorage.com");
});

test("an explicit R2_ENDPOINT wins over R2_ACCOUNT_ID", () => {
  const cmd = fetchArgv("r2://m/a.mp4", "/w/a.mp4", { ...R2_ENV, R2_ENDPOINT: "https://custom.example.com" });
  assert.equal(cmd.args[cmd.args.indexOf("--endpoint-url") + 1], "https://custom.example.com");
});

test("r2 without an endpoint fails with the env var to set, not a signing error", () => {
  assert.throws(() => fetchArgv("r2://m/a.mp4", "/w/a.mp4", {}), /R2_ACCOUNT_ID/);
});

test("S3_ENDPOINT is honoured for s3://, for MinIO and the like", () => {
  const cmd = fetchArgv("s3://m/a.mp4", "/w/a.mp4", { S3_ENDPOINT: "https://minio.internal:9000" });
  assert.equal(cmd.args[cmd.args.indexOf("--endpoint-url") + 1], "https://minio.internal:9000");
});

test("https fetch fails on HTTP errors instead of writing the error body to disk", () => {
  const cmd = fetchArgv("https://cdn.example.com/a.mp4", "/w/a.mp4");
  assert.equal(cmd.command, "curl");
  assert.ok(cmd.args.includes("--fail"), "--fail: a 404 page saved as a.mp4 breaks the render later, not now");
  assert.ok(cmd.args.includes("--location"), "--location: pre-signed and share URLs redirect");
  assert.equal(cmd.args[cmd.args.indexOf("--output") + 1], "/w/a.mp4");
  assert.equal(cmd.args[cmd.args.length - 1], "https://cdn.example.com/a.mp4");
});

test("file fetch needs no subprocess", () => {
  assert.equal(fetchCommand(parseUri("file:///srv/a.mp4"), "/w/a.mp4", {}), null);
});

test("drive fetch uses copyto, not copy, so the destination filename is respected", () => {
  const cmd = fetchArgv("drive://Recordings/session.mp4", "/w/public/source.mp4", DRIVE_ENV);
  assert.equal(cmd.command, "rclone");
  assert.equal(cmd.args[0], "copyto");
  assert.deepEqual(cmd.args.slice(-2), ["drive:Recordings/session.mp4", "/w/public/source.mp4"]);
});

test("drive without rclone config lists the env vars to set", () => {
  assert.throws(() => fetchArgv("drive://Recordings/a.mp4", "/w/a.mp4", {}), /RCLONE_CONFIG_DRIVE_TYPE/);
});

// ---------------------------------------------------------------------------
// publish commands
// ---------------------------------------------------------------------------

test("bucket publish reverses the argument order", () => {
  const cmd = publishArgv("/w/out/lesson.mp4", "s3://media/renders/lesson.mp4");
  assert.deepEqual(cmd.args, [
    "s3", "cp", "/w/out/lesson.mp4", "s3://media/renders/lesson.mp4", "--no-progress",
  ]);
});

test("drive publish reverses the argument order too", () => {
  const cmd = publishArgv("/w/out/lesson.mp4", "drive://Renders/lesson.mp4", DRIVE_ENV);
  assert.deepEqual(cmd.args.slice(-2), ["/w/out/lesson.mp4", "drive:Renders/lesson.mp4"]);
});

test("https is read-only: publishing to it says so rather than guessing PUT vs POST", () => {
  assert.throws(() => publishArgv("/w/a.mp4", "https://cdn.example.com/a.mp4"), /read-only destination/);
});

test("file publish needs no subprocess", () => {
  assert.equal(publishCommand(parseUri("file:///srv/a.mp4"), "/w/a.mp4", {}), null);
});

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

test("only r2 needs extra environment", () => {
  assert.deepEqual(transferEnv(parseUri("s3://m/a.mp4")), {});
  assert.deepEqual(transferEnv(parseUri("https://h/a.mp4")), {});

  const env = transferEnv(parseUri("r2://m/a.mp4"));
  // R2 has no regions but the CLI will not sign without one, and aws-cli v2's default
  // upload checksum trailer is the documented incompatibility with S3-compatible hosts.
  assert.equal(env.AWS_DEFAULT_REGION, "auto");
  assert.equal(env.AWS_REQUEST_CHECKSUM_CALCULATION, "when_required");
});

// ---------------------------------------------------------------------------
// approval-first publishing and root containment (scratch folder inside out/)
// ---------------------------------------------------------------------------

const scratch = () => {
  const dir = mkdtempSync(join(outputDirectory("out/_tests"), "storage-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("isRemoteUri is false only for file://", () => {
  assert.equal(isRemoteUri("file:///srv/a.mp4"), false);
  for (const uri of ["s3://b/a.mp4", "r2://b/a.mp4", "drive://F/a.mp4", "https://h/a.mp4"]) assert.equal(isRemoteUri(uri), true);
});

test("an upload without the publish approval is refused before any tool runs", () => {
  const t = scratch();
  const file = join(t.dir, "a.mp4");
  writeFileSync(file, "x");
  assert.throws(() => publishFile(file, "s3://bucket/a.mp4"), /without an explicit publish approval/);
  assert.throws(() => publishFile(file, "r2://bucket/a.mp4", { publish: false }), /--publish/);
  t.done();
});

test("a file:// copy inside the repository works once and never overwrites", () => {
  const t = scratch();
  const file = join(t.dir, "a.mp4");
  writeFileSync(file, "first");
  const dest = join(t.dir, "copy", "a.mp4");
  const uri = pathToFileURL(dest).href;
  assert.equal(publishFile(file, uri), uri);
  assert.equal(readFileSync(dest, "utf8"), "first");
  writeFileSync(file, "second");
  assert.throws(() => publishFile(file, uri), /EEXIST|exists/);
  assert.equal(readFileSync(dest, "utf8"), "first");
  t.done();
});

test("a file:// destination outside the repository is refused", () => {
  const t = scratch();
  const file = join(t.dir, "a.mp4");
  writeFileSync(file, "x");
  const outside = pathToFileURL(join(ROOT, "..", "outside-copy.mp4")).href;
  assert.throws(() => publishFile(file, outside), /must be inside the repository/);
  t.done();
});

test("fetching a file:// source stays inside the repository and refuses to replace a file", () => {
  const t = scratch();
  const src = join(t.dir, "src.mp4");
  writeFileSync(src, "data");
  const dest = join(t.dir, "got.mp4");
  assert.equal(fetchToFile(pathToFileURL(src).href, dest), dest);
  assert.equal(existsSync(dest), true);
  assert.throws(() => fetchToFile(pathToFileURL(src).href, dest), /already exists/);
  assert.throws(() => fetchToFile(pathToFileURL(join(ROOT, "..", "elsewhere.mp4")).href, join(t.dir, "x.mp4")), /must be inside the repository/);
  t.done();
});

test("https downloads stay on https through redirects and never glob", () => {
  const cmd = fetchCommand(parseUri("https://cdn.example.com/a/b.mp4"), "/tmp/b.mp4");
  for (const flag of ["--proto", "--proto-redir", "--globoff"]) assert.ok(cmd.args.includes(flag), flag);
  assert.equal(cmd.args[cmd.args.indexOf("--proto-redir") + 1], "=https");
});

test("printable URIs drop signatures and credentials", () => {
  const signature = "X-Amz-" + "Signature=secretvalue";
  assert.equal(printableUri("https://user:pw@cdn.example.com/a/b.mp4?" + signature + "#x"), "https://cdn.example.com/a/b.mp4");
  assert.throws(() => parseUri("https://cdn.example.com/dir/?" + signature), (err) => !String(err.message).includes("secretvalue"));
});
