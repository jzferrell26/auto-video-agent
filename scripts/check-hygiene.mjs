import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ROOT, main } from "../engine/pipeline/runtime.mjs";

export function inspectFile(path, content) {
  const findings = [];
  if (/(^|\/)(?:node_modules|public|brand-props|_sources|sources|out|renders|library|\.aws|\.gcp)\//.test(path)) findings.push("generated/private directory");
  if (/\.(?:mp4|mov|webm|wav|mp3|m4a|pem|key|p12|pfx|srt|vtt)$/i.test(path)) findings.push("media, captions or key file");
  if (/(^|\/)\.env(?:\..+)?$/.test(path) && !path.endsWith(".example")) findings.push("environment file");
  if (/(^|\/)(?:credentials|serviceAccount[^/]*)\.json$/.test(path)) findings.push("credential file");
  if (/\.(?:words|segments)\.json$|\.transcript\.txt$/.test(path)) findings.push("transcript");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) findings.push("private key material");
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk_(?:live|test)_[A-Za-z0-9]{20,})/.test(content)) findings.push("token-shaped value");
  if (/(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\s/\\]+|\/(?:Users|home)\/[a-zA-Z0-9._-]+\/)/.test(content)) findings.push("machine-specific home path");
  if (/https?:\/\/[^\s)]+(?:X-Amz-Signature|X-Goog-Signature)=/i.test(content)) findings.push("signed media URL");
  if (path.endsWith(".example") && path.includes(".env")) {
    const assignments = content.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
    if (assignments.some((line) => line.split("=").slice(1).join("=").trim())) findings.push("populated example environment");
  }
  return findings;
}

export function checkHygiene() {
  const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean))];
  const failures = [];
  for (const path of files) {
    const absolute = resolve(ROOT, path);
    if (!existsSync(absolute)) continue;
    if (lstatSync(absolute).isSymbolicLink()) { failures.push(path + ": symlink is not allowed"); continue; }
    const data = readFileSync(absolute);
    if (data.length > 2 * 1024 * 1024 || data.includes(0)) { failures.push(path + ": binary/oversized file needs explicit review"); continue; }
    const content = data.toString("utf8");
    for (const finding of inspectFile(path, content)) failures.push(path + ": " + finding);
    if (path.endsWith(".md")) {
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(resolve(dirname(absolute), decodeURIComponent(target)))) failures.push(path + ": broken local documentation link");
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("Hygiene checks passed for " + files.length + " files. Pattern checks are not a complete secret or privacy audit.");
}
main(import.meta.url, checkHygiene);
