// Moves finished videos into an archive folder, one subfolder per project. The archive is
// meant to be a cloud-synced folder (for example a Google Drive for desktop folder), so a
// finished render leaves the machine instead of piling up in out/.
//
// A source is deleted only after its archived copy has the same SHA-256, the source has not
// changed since it was hashed, and the two are not the same file under another name. Copies
// never overwrite; a failed copy is removed and the source stays.
//
// Usage:
//   npm run archive -- --project "Spring Promo" out/spring/final.mp4 out/spring/final.srt
//   npm run archive -- --project "Demo course" --folder out/lessons   (its top-level videos)
//   Flags: --keep (copy only), --to <dir> (override the archive root).
// The root comes from --to, else VIDEO_ARCHIVE_DIR (read from the repo's ignored .env when
// present). Inputs must be inside this repository, usually under out/.
import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ROOT, assertInsideRoot, main } from "./runtime.mjs";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
// Deliverables that travel with a video: captions, chapters, descriptions, ad copy.
const COMPANION_EXTENSIONS = new Set([".srt", ".vtt", ".txt", ".md"]);
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A project name that is safe as one Windows or POSIX folder name. */
export function projectFolderName(project) {
  const name = String(project ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!name) throw new Error("archive: --project needs a name, e.g. --project \"Spring Promo\"");
  if (RESERVED.test(name)) throw new Error(`archive: "${name}" is a reserved Windows name; pick another project name`);
  return name;
}

/** Files to archive. Explicit files must be videos or companions; folders need --folder. */
export async function expandInputs(inputs, { folder = false } = {}) {
  const files = new Set(); // the same file named twice is archived once
  for (const input of inputs) {
    const path = resolve(input);
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error(`archive: not found: ${input}`);
    if (info.isFile()) {
      const ext = extname(path).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext) && !COMPANION_EXTENSIONS.has(ext)) {
        throw new Error(`archive: ${input} is not a video or caption/text deliverable; refusing to archive it`);
      }
      files.add(path);
      continue;
    }
    if (!folder) throw new Error(`archive: ${input} is a folder; pass --folder to archive every video in it`);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.add(join(path, entry.name));
    }
  }
  return [...files];
}

/** The archive root must be an absolute folder that exists. */
async function checkRoot(root) {
  if (!root || !isAbsolute(root)) {
    throw new Error(`archive: archive folder must be an absolute path, got ${root || "(unset)"}. Set VIDEO_ARCHIVE_DIR in .env or pass --to.`);
  }
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    throw new Error(
      `archive: archive folder not found: ${root}. Set VIDEO_ARCHIVE_DIR in .env or pass --to, ` +
        "and if it is a Google Drive for desktop folder, make sure Drive for desktop is running."
    );
  }
}

/** SHA-256 of a file, streamed so multi-gigabyte renders do not load into memory. */
export function sha256(path) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;

/**
 * Copies each file into <root>/<project>/, verifies the copy by SHA-256, then removes the
 * source unless `keep`. Returns one result per file; `copy` is injectable for tests.
 */
export async function archiveFiles({ files, root, project, keep = false, copy = copyFile }) {
  await checkRoot(root);
  const realRoot = await realpath(root);
  const dir = join(root, projectFolderName(project));
  await mkdir(dir, { recursive: true });

  const results = [];
  for (const file of files) {
    const dest = join(dir, basename(file));
    const result = { file, dest, bytes: 0, status: "failed" };
    results.push(result);
    let created = false;
    try {
      if (dirname(dest) !== dir) throw new Error("destination escaped the project folder");
      // Never treat a file that already lives in the archive as a source to delete.
      const rel = relative(realRoot, await realpath(file));
      if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        result.status = "skipped";
        result.error = "already inside the archive";
        continue;
      }
      const source = await stat(file, { bigint: true });
      result.bytes = Number(source.size);
      const existing = await stat(dest, { bigint: true }).catch(() => null);
      if (existing && sameFile(source, existing)) {
        result.status = "skipped";
        result.error = "source and archive copy are the same file";
        continue;
      }
      if (existing && !existing.isFile()) {
        result.error = "the archive already has a folder with this name";
        continue;
      }
      const sourceHash = await sha256(file);
      if (existing) {
        if (existing.size !== source.size || (await sha256(dest)) !== sourceHash) {
          result.error = "a different file with this name is already archived; rename one of them";
          continue;
        }
      } else {
        try {
          await copy(file, dest, constants.COPYFILE_EXCL); // fails rather than overwrite
        } catch (err) {
          // A copy that died partway may have left bytes behind; EEXIST means the file is not ours.
          if (/** @type {any} */ (err)?.code !== "EEXIST") await rm(dest, { force: true });
          throw err;
        }
        created = true;
        if ((await sha256(dest)) !== sourceHash) {
          result.error = "archived copy does not match the source; source kept";
          continue;
        }
      }
      created = false; // verified: the archived copy stays from here on
      if (!keep) {
        // A render that landed while this ran must not be deleted unarchived.
        const now = await stat(file, { bigint: true });
        if (now.size !== source.size || now.mtimeNs !== source.mtimeNs) {
          result.error = "source changed while archiving; source kept, archive holds the earlier version";
          continue;
        }
        await rm(file);
      }
      result.status = existing ? "already archived" : keep ? "copied" : "moved";
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (created) await rm(dest, { force: true }); // an unverified copy never stays behind
    }
  }
  return results;
}

/** Command-line flags; a flag that needs a value refuses another flag in its place. */
export function parseArgs(argv) {
  /** @type {{ inputs: string[], keep: boolean, folder: boolean, project?: string, to?: string }} */
  const args = { inputs: [], keep: false, folder: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`archive: ${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = value(++i, a);
    else if (a === "--to") args.to = value(++i, a);
    else if (a === "--keep") args.keep = true;
    else if (a === "--folder") args.folder = true;
    else if (a.startsWith("--")) throw new Error(`archive: unknown flag ${a}`);
    else args.inputs.push(a);
  }
  return args;
}

/**
 * Read one key from dotenv-style text. Only the archive folder is needed here, so the rest of
 * the file (which may hold delivery tokens) is never loaded into this process.
 */
export function readEnvValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    return match[2].trim().replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

export async function archiveCommand(argv) {
  const args = parseArgs(argv);
  const envFile = join(ROOT, ".env");
  const fromFile = existsSync(envFile) ? readEnvValue(readFileSync(envFile, "utf8"), "VIDEO_ARCHIVE_DIR") : undefined;
  const root = args.to ?? (process.env.VIDEO_ARCHIVE_DIR || fromFile);
  await checkRoot(root);
  if (args.inputs.length === 0) throw new Error("archive: name the finished files (or --folder a folder) to archive");
  const inputs = args.inputs.map((input) => assertInsideRoot(input, "archive: " + input));
  const files = await expandInputs(inputs, { folder: args.folder });
  if (files.length === 0) throw new Error("archive: no files to archive (a folder contributes only its video files)");
  console.log(`archiving ${files.length} file(s) into ${root}:`);
  for (const f of files) console.log(`  ${f}`);
  const results = await archiveFiles({ files, root, project: args.project, keep: args.keep });
  for (const r of results) {
    const mb = (r.bytes / 1048576).toFixed(1).padStart(8);
    console.log(`${r.status.padEnd(16)} ${mb} MB  ${r.dest}${r.error ? `  (${r.error})` : ""}`);
  }
  console.log("Note: a sync client (for example Google Drive for desktop) uploads these in the background; confirm they landed before clearing its cache.");
  const failed = results.filter((r) => r.status === "failed").length;
  if (failed) {
    console.error(`archive: ${failed} of ${results.length} failed; those sources were not removed`);
    process.exitCode = 1;
  }
}

main(import.meta.url, archiveCommand);
