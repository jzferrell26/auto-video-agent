// Regenerate the composition tables in engine/README.md from engine/compositions.mjs.
//
// Hand-kept tables drift. The composition reference is generated instead, from the same
// registry that validates props before a render, so the docs cannot disagree with the code.
//
// Usage:
//   npm run docs         rewrite the generated block in place
//   npm run docs:check   exit 1 if the block is stale (part of `npm run check`)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPOSITIONS, COMPOSITION_IDS } from "../compositions.mjs";
import { ROOT, main } from "./runtime.mjs";

const START = "<!-- BEGIN GENERATED: compositions (engine/pipeline/gen-docs.mjs) -->";
const END = "<!-- END GENERATED: compositions -->";

/** Render a prop's schema as a short human-readable type. */
function typeOf(schema) {
  switch (schema.type) {
    case "enum":
      return schema.values.map((v) => "`" + v + "`").join(" \\| ");
    case "array":
      return typeOf(schema.of) + "[]";
    case "object":
      return schema.fields ? "{ " + Object.keys(schema.fields).join(", ") + " }" : "object";
    default:
      return schema.type;
  }
}

function bounds(schema) {
  const parts = [];
  if (schema.min !== undefined) parts.push((schema.exclusiveMin ? "> " : ">= ") + schema.min);
  if (schema.max !== undefined) parts.push("<= " + schema.max);
  if (schema.minLength !== undefined) parts.push(">= " + schema.minLength + " item(s)");
  return parts.join(", ");
}

function compositionTable() {
  const rows = COMPOSITION_IDS.map((id) => "| `" + id + "` | " + (COMPOSITIONS[id].still ? "Still image" : "Video") + " | " + COMPOSITIONS[id].output + " |");
  return ["| ID | Renders | Output |", "|---|---|---|", ...rows].join("\n");
}

function propsReference() {
  const out = [];
  for (const id of COMPOSITION_IDS) {
    const { output, props } = COMPOSITIONS[id];
    out.push("#### `" + id + "`", "", output, "", "| Prop | Type | Required | Constraint |", "|---|---|---|---|");
    for (const [name, schema] of Object.entries(props)) {
      out.push("| `" + name + "` | " + typeOf(schema) + " | " + (schema.required ? "yes" : "no") + " | " + (bounds(schema) || "none") + " |");
    }
    out.push("");
  }
  return out.join("\n");
}

/** The generated block, with LF line endings. */
export function generatedBlock() {
  return [
    START,
    "<!-- Do not edit by hand. Source: engine/compositions.mjs. Regenerate with npm run docs. -->",
    "",
    compositionTable(),
    "",
    "<details>",
    "<summary>Full prop reference (validated before every render)</summary>",
    "",
    propsReference().trimEnd(),
    "",
    "</details>",
    END,
  ].join("\n");
}

/** Replace the text between the markers (inclusive) with `block`. */
export function spliceBlock(existing, block) {
  const startAt = existing.indexOf(START);
  const endAt = existing.indexOf(END);
  if (startAt === -1 || endAt === -1) {
    throw new Error("Could not find the generated-block markers in engine/README.md. Add these two lines where the table belongs:\n  " + START + "\n  " + END);
  }
  if (endAt < startAt) throw new Error("The generated-block markers in engine/README.md are in the wrong order.");
  return existing.slice(0, startAt) + block + existing.slice(endAt + END.length);
}

export function genDocs(args) {
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length) throw new Error("Unknown argument " + unknown[0] + ". Usage: npm run docs [-- --check]");
  const path = resolve(ROOT, "engine/README.md");
  const current = readFileSync(path, "utf8");
  // A Windows checkout can read as CRLF. Write the block in the file's own style.
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const updated = spliceBlock(current, generatedBlock().replaceAll("\n", eol));
  if (updated === current) {
    console.log("engine/README.md is up to date.");
    return;
  }
  if (args.includes("--check")) {
    throw new Error("engine/README.md is out of date with engine/compositions.mjs. Run: npm run docs");
  }
  writeFileSync(path, updated);
  console.log("engine/README.md updated (" + COMPOSITION_IDS.length + " compositions).");
}

main(import.meta.url, genDocs);
