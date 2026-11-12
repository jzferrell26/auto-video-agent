// Move media in and out of the repository by URI, without shelling out through a string.
//
// ADVANCED. The default workflow is local: files live in the repository and renders stay in
// out/. This module exists for people who keep source media or finished renders in a bucket
// or a synced folder. It only turns a URI into an argument array for a transfer tool:
//
//   file:///abs/path         A file inside this repository (copied in-process, never overwritten).
//   https://host/path        Download only, through curl. Needs network access.
//   s3://bucket/key          Needs the AWS CLI and your own credentials in the environment.
//   r2://bucket/key          S3-compatible. Needs the AWS CLI plus R2_ACCOUNT_ID (or R2_ENDPOINT).
//   drive://Folder/file.mp4  Needs rclone, with a remote named `drive` configured by environment.
//
// Uploading to anything other than file:// is an external write. publishFile refuses it unless
// the caller passes { publish: true }, which render-job.mjs only does for an explicit --publish.
// Nothing here runs at import time, and every command builder is a pure function.

import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertInsideRoot } from "./runtime.mjs";

/**
 * @typedef {{ scheme: "s3" | "r2", bucket: string, key: string }} BucketRef
 * @typedef {{ scheme: "https", url: string, key: string }} HttpsRef
 * @typedef {{ scheme: "file", path: string, key: string }} FileRef
 * @typedef {{ scheme: "drive", path: string, key: string }} DriveRef
 * @typedef {BucketRef | HttpsRef | FileRef | DriveRef} StorageRef
 */

/** A URI that is safe to print: no userinfo, query string or fragment (pre-signed signatures live there). */
export function printableUri(uri) {
  try {
    const u = new URL(String(uri));
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return String(uri).replace(/[?#].*$/, "");
  }
}

const SCHEMES = ["s3", "r2", "https", "file", "drive"];

/**
 * A Drive file ID looks like `1a2B3c...`; long, no dot, no slash. rclone addresses Drive
 * by PATH, not by ID, so a bare ID here is a mistake worth catching by name rather than
 * letting rclone report "directory not found" about something that is not a directory.
 */
const DRIVE_ID_SHAPED = /^[A-Za-z0-9_-]{25,}$/;

/**
 * Parse a storage URI into a typed reference.
 *
 * @param {string} uri
 * @returns {StorageRef}
 */
export function parseUri(uri) {
  if (typeof uri !== "string" || uri.trim() === "") {
    throw new Error("storage URI is empty");
  }
  const trimmed = uri.trim();
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `not a storage URI: ${JSON.stringify(printableUri(trimmed))}; expected one of ${SCHEMES.map((s) => `${s}://`).join(", ")}`
    );
  }
  const scheme = match[1].toLowerCase();
  const rest = match[2];

  if (scheme === "http") {
    // Refusing rather than upgrading: silently rewriting a URL the caller wrote is a
    // worse surprise than an error, and a plaintext source is often a typo for https.
    throw new Error("http:// is not supported; use https:// (a source pulled in the clear is not worth the retry)");
  }
  if (!SCHEMES.includes(scheme)) {
    throw new Error(`unsupported storage scheme ${scheme}://; supported: ${SCHEMES.join(", ")}`);
  }

  if (scheme === "https") {
    if (rest === "") throw new Error("https:// URI has no host");
    return { scheme: "https", url: trimmed, key: safeKey(new URL(trimmed).pathname.replace(/^\/+/, ""), trimmed) };
  }

  if (scheme === "file") {
    // file:///abs/path; the empty authority leaves a leading slash, which is the path.
    const path = decodeURIComponent(rest);
    if (!path.startsWith("/")) {
      throw new Error(`file:// URI must be absolute (three slashes): ${JSON.stringify(printableUri(uri))}`);
    }
    // file:///C:/dir/file is the Windows form: there the leading slash belongs to the URI,
    // not the path; kept, copyFileSync resolves "/C:/dir" against the current drive and
    // reads C:\C:\dir.
    const local = /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
    return { scheme: "file", path: local, key: safeKey(path.replace(/^\/+/, ""), uri) };
  }

  if (scheme === "drive") {
    const path = safeKey(rest, uri);
    if (DRIVE_ID_SHAPED.test(path)) {
      throw new Error(
        `drive://${path} looks like a Drive file ID, and rclone addresses Drive by path, not by ID.\n` +
          "Point the remote at the file's parent folder and name the file instead:\n" +
          "  RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID=<the parent folder's ID>\n" +
          "  drive://session.mp4"
      );
    }
    return { scheme: "drive", path, key: path };
  }

  // s3:// and r2://; bucket is the authority, everything after it is the key.
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    throw new Error(`${scheme}:// URI needs a bucket AND a key: ${JSON.stringify(printableUri(uri))} (want ${scheme}://bucket/key)`);
  }
  const bucket = rest.slice(0, slash);
  const key = safeKey(rest.slice(slash + 1), uri);
  return { scheme: /** @type {"s3" | "r2"} */ (scheme), bucket, key };
}

/**
 * Reject keys that would escape a destination directory once joined. The URI comes from a
 * workflow input, so it is caller-controlled but not necessarily caller-*reviewed*.
 *
 * @param {string} key
 * @param {string} uri for the error message
 * @returns {string}
 */
function safeKey(key, uri) {
  if (key === "") throw new Error(`storage URI has no path: ${JSON.stringify(printableUri(uri))}`);
  const segments = key.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error(`storage URI path may not contain . or .. segments: ${JSON.stringify(printableUri(uri))}`);
  }
  if (segments[segments.length - 1] === "") {
    throw new Error(`storage URI points at a directory, not a file: ${JSON.stringify(printableUri(uri))}`);
  }
  return key;
}

/**
 * The filename a URI should land under locally. Basename only; a key of `a/b/c.mp4`
 * becomes `c.mp4`, so nothing writes outside the destination directory.
 *
 * @param {string | StorageRef} uriOrRef
 * @returns {string}
 */
export function localName(uriOrRef) {
  const ref = typeof uriOrRef === "string" ? parseUri(uriOrRef) : uriOrRef;
  const last = ref.key.split("/").pop() || "";
  if (last === "") throw new Error(`cannot derive a filename from ${ref.scheme}://${ref.key}`);
  return last;
}

/**
 * Join a destination prefix and a filename into a URI. Used when publishing a directory
 * of outputs under one prefix.
 *
 * @param {string} prefix e.g. `s3://bucket/renders/2026-08-08`
 * @param {string} name e.g. `lesson-01.mp4`
 * @returns {string}
 */
export function joinUri(prefix, name) {
  if (name.includes("/")) throw new Error(`joinUri takes a filename, not a path: ${JSON.stringify(name)}`);
  return `${prefix.replace(/\/+$/, "")}/${name}`;
}

/**
 * The S3 endpoint to talk to. Real S3 needs none; R2's is per-account.
 *
 * @param {"s3" | "r2"} scheme
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function endpointFor(scheme, env) {
  if (scheme === "s3") return env.S3_ENDPOINT || null;
  if (env.R2_ENDPOINT) return env.R2_ENDPOINT;
  if (env.R2_ACCOUNT_ID) return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  throw new Error(
    "r2:// needs an endpoint; set R2_ACCOUNT_ID (preferred) or the full R2_ENDPOINT.\n" +
      "Credentials come from the usual AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY pair; an R2 API token supplies both."
  );
}

/**
 * Extra environment a transfer needs, on top of what the process already has.
 *
 * @param {StorageRef} ref
 * @returns {Record<string, string>}
 */
export function transferEnv(ref) {
  if (ref.scheme !== "r2") return {};
  return {
    // R2 has no regions, but the AWS CLI refuses to sign without one.
    AWS_DEFAULT_REGION: "auto",
    // aws-cli v2 adds a CRC32 integrity trailer to every upload by default. Cloudflare
    // documents this pair as the compatibility setting for S3-compatible endpoints, and
    // `when_required` / `when_supported` are the AWS defaults' conservative siblings, so
    // this is safe against real S3 too.
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_supported",
  };
}

/**
 * Assert the environment can address the Drive remote at all, before rclone reports it as
 * a missing directory.
 *
 * @param {Record<string, string | undefined>} env
 */
function assertDriveConfigured(env) {
  if (env.RCLONE_CONFIG_DRIVE_TYPE) return;
  throw new Error(
    "drive:// needs an rclone remote named `drive`, configured entirely from the environment:\n" +
      "  RCLONE_CONFIG_DRIVE_TYPE=drive\n" +
      "  RCLONE_CONFIG_DRIVE_SERVICE_ACCOUNT_FILE=/path/to/service-account.json\n" +
      "  RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID=<folder shared with the service account>\n" +
      "A service account is the point: it authenticates with no browser, which is what an\n" +
      "unattended render needs. Share the folder with the service account's email address."
  );
}

/**
 * The argv that pulls `ref` down to `dest`.
 *
 * `null` means "no subprocess needed"; a `file://` source is copied in-process.
 *
 * @param {StorageRef} ref
 * @param {string} dest absolute local path to write
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ command: string, args: string[] } | null}
 */
export function fetchCommand(ref, dest, env = process.env) {
  switch (ref.scheme) {
    case "file":
      return null;

    case "https":
      return {
        command: "curl",
        args: [
          "--fail", // a 404 body written to disk is worse than a non-zero exit
          "--silent",
          "--show-error",
          "--location", // pre-signed URLs and Drive share links both redirect
          "--proto", "=https", // https only, and a redirect may not downgrade or switch protocol
          "--proto-redir", "=https",
          "--max-redirs", "5",
          "--globoff", // braces and brackets in a URL are literal, never several downloads
          "--retry", "4",
          "--retry-delay", "2",
          "--retry-connrefused",
          "--output", dest,
          ref.url,
        ],
      };

    case "drive": {
      assertDriveConfigured(env);
      return {
        command: "rclone",
        // copyto, not copy: `copy` treats the last argument as a directory and keeps the
        // source name, which quietly ignores `dest`.
        args: ["copyto", "--retries", "4", "--low-level-retries", "10", `drive:${ref.path}`, dest],
      };
    }

    default: {
      const endpoint = endpointFor(ref.scheme, env);
      return {
        command: "aws",
        args: [
          "s3", "cp",
          `s3://${ref.bucket}/${ref.key}`,
          dest,
          "--no-progress", // the CI log is a file, not a terminal
          ...(endpoint ? ["--endpoint-url", endpoint] : []),
        ],
      };
    }
  }
}

/**
 * The argv that pushes a local file up to `ref`.
 *
 * @param {StorageRef} ref
 * @param {string} localPath absolute local path to read
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ command: string, args: string[] } | null}
 */
export function publishCommand(ref, localPath, env = process.env) {
  switch (ref.scheme) {
    case "file":
      return null;

    case "https":
      // Deliberately not guessing: a PUT to a pre-signed URL and a POST to an upload API
      // are different requests, and picking one would be wrong half the time.
      throw new Error("https:// is a read-only destination; publish to s3://, r2://, drive:// or file://");

    case "drive": {
      assertDriveConfigured(env);
      return {
        command: "rclone",
        args: ["copyto", "--retries", "4", "--low-level-retries", "10", localPath, `drive:${ref.path}`],
      };
    }

    default: {
      const endpoint = endpointFor(ref.scheme, env);
      return {
        command: "aws",
        args: [
          "s3", "cp",
          localPath,
          `s3://${ref.bucket}/${ref.key}`,
          "--no-progress",
          ...(endpoint ? ["--endpoint-url", endpoint] : []),
        ],
      };
    }
  }
}

/**
 * Run a built command, surfacing the tool's own diagnosis on failure.
 *
 * @param {{ command: string, args: string[] }} cmd
 * @param {Record<string, string>} extraEnv
 */
function run(cmd, extraEnv) {
  try {
    execFileSync(cmd.command, cmd.args, {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "inherit", "pipe"],
    });
  } catch (err) {
    const e = /** @type {{ stderr?: Buffer, code?: string }} */ (err);
    if (e.code === "ENOENT") {
      throw new Error(`${cmd.command} is not installed; needed to transfer this URI`);
    }
    const detail = e.stderr?.toString().trim();
    throw new Error(`${cmd.command} ${cmd.args[0]} failed${detail ? `:\n${detail}` : ""}`);
  }
}

/**
 * Pull a source down to a local path, creating parent directories. Refuses to replace an
 * existing file. A file:// source must be inside the repository.
 *
 * @param {string} uri
 * @param {string} dest
 * @returns {string} the destination path
 */
export function fetchToFile(uri, dest) {
  const ref = parseUri(uri);
  const abs = assertInsideRoot(dest, "Destination");
  if (existsSync(abs)) throw new Error("Destination already exists: choose another name or remove it first.");
  mkdirSync(dirname(abs), { recursive: true });
  const cmd = fetchCommand(ref, abs);
  if (cmd) run(cmd, transferEnv(ref));
  else copyFileSync(assertInsideRoot(/** @type {FileRef} */ (ref).path, "A file:// source"), abs, constants.COPYFILE_EXCL);
  return abs;
}

/** True when a destination would leave the machine. */
export function isRemoteUri(uri) {
  return parseUri(uri).scheme !== "file";
}

/**
 * Push a local file up to a destination URI.
 *
 * A file:// destination must be inside the repository and is never overwritten. Any other
 * scheme is an external write and needs `publish: true`.
 *
 * @param {string} localPath
 * @param {string} uri
 * @param {{ publish?: boolean }} [options]
 * @returns {string} the destination URI
 */
export function publishFile(localPath, uri, { publish = false } = {}) {
  const ref = parseUri(uri);
  if (ref.scheme !== "file" && !publish) {
    throw new Error("Refusing to upload to " + ref.scheme + ":// without an explicit publish approval (--publish).");
  }
  const abs = assertInsideRoot(localPath, "Local file");
  const cmd = publishCommand(ref, abs);
  if (cmd) run(cmd, transferEnv(ref));
  else {
    const path = assertInsideRoot(/** @type {FileRef} */ (ref).path, "A file:// destination");
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(abs, path, constants.COPYFILE_EXCL);
  }
  return uri;
}
