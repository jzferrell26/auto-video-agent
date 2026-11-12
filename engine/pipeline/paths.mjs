// The one place that decides where the repository root is.
//
// A fixed relative hop count (for example "two directories above this file") rots the
// moment a script moves, and the failure is quiet: paths point one folder off and nothing
// can render. The root is instead found by walking up to the first directory that holds
// a package.json. runtime.mjs re-exports the result as ROOT; import it from there.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `startDir` until a directory holds package.json.
 *
 * @param {string} [startDir] defaults to the directory of this file
 * @param {number} [maxHops] how many parent directories to try before giving up
 * @returns {string} absolute path of the repository root
 */
export function findRepoRoot(startDir = dirname(fileURLToPath(import.meta.url)), maxHops = 8) {
  let dir = resolve(startDir);
  for (let hops = 0; hops <= maxHops; hops++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the repository root: no package.json above " + resolve(startDir) + ".");
}

/** Absolute path of the repository root (the folder with package.json and src/index.tsx). */
export const REPO_ROOT = findRepoRoot();

/** The Remotion entry point, relative to REPO_ROOT, as the CLI wants it. */
export const REMOTION_ENTRY = "src/index.tsx";
