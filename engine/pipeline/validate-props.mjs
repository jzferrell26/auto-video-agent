// Fail-fast prop validation for Remotion composition props.
//
// A render pipeline's worst failure mode is dying at minute 19 of a 20-minute render
// because a prop was malformed. The classic case here: `ffprobe` hiccups, parseFloat
// yields NaN, `clipSeconds: NaN` propagates into calculateMetadata, and Remotion dies
// with something unhelpful , after the clip encode has already been paid for.
//
// So: validate against engine/compositions.mjs BEFORE writing the props JSON.
// Pure functions, no I/O , tested by validate-props.test.mjs.
import { COMPOSITIONS } from "../compositions.mjs";

/** A finite number: rejects NaN and +/-Infinity, which JSON.stringify turns into `null`. */
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const label = (path) => (path.length ? path.join(".") : "(root)");

function checkNumericBounds(schema, value, path, errors) {
  const { min, max, exclusiveMin } = schema;
  if (min !== undefined) {
    if (exclusiveMin ? value <= min : value < min) {
      errors.push(`${label(path)}: must be ${exclusiveMin ? ">" : ">="} ${min}, got ${value}`);
    }
  }
  if (max !== undefined && value > max) {
    errors.push(`${label(path)}: must be <= ${max}, got ${value}`);
  }
}

function checkValue(schema, value, path, errors) {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        errors.push(`${label(path)}: expected string, got ${describe(value)}`);
      } else if (value.length === 0 && !schema.allowEmpty) {
        errors.push(`${label(path)}: expected a non-empty string`);
      }
      return;

    case "number":
      // NaN is the failure this whole module exists to catch , name it explicitly.
      if (!isFiniteNumber(value)) {
        errors.push(`${label(path)}: expected a finite number, got ${describe(value)}`);
        return;
      }
      checkNumericBounds(schema, value, path, errors);
      return;

    case "integer":
      if (!isFiniteNumber(value) || !Number.isInteger(value)) {
        errors.push(`${label(path)}: expected an integer, got ${describe(value)}`);
        return;
      }
      checkNumericBounds(schema, value, path, errors);
      return;

    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`${label(path)}: expected boolean, got ${describe(value)}`);
      }
      return;

    case "enum":
      if (!schema.values.includes(value)) {
        errors.push(`${label(path)}: expected one of ${schema.values.join(" | ")}, got ${describe(value)}`);
      }
      return;

    case "object":
      if (!isPlainObject(value)) {
        errors.push(`${label(path)}: expected object, got ${describe(value)}`);
        return;
      }
      // `fields` is optional: a bare {type:"object"} accepts any plain object
      // (theme partials, where the .tsx type is the real contract).
      if (schema.fields) checkFields(schema.fields, value, path, errors);
      return;

    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${label(path)}: expected array, got ${describe(value)}`);
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${label(path)}: expected at least ${schema.minLength} item(s), got ${value.length}`);
      }
      value.forEach((item, i) => checkValue(schema.of, item, [...path, String(i)], errors));
      return;
    }

    default:
      errors.push(`${label(path)}: unknown schema type "${schema.type}" (bug in compositions.mjs)`);
  }
}

function checkFields(fields, obj, path, errors) {
  for (const [key, schema] of Object.entries(fields)) {
    const value = obj[key];
    if (value === undefined || value === null) {
      if (schema.required) errors.push(`${label([...path, key])}: required, but missing`);
      continue;
    }
    checkValue(schema, value, [...path, key], errors);
  }
}

function describe(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") return `"${value.slice(0, 40)}"`;
  return String(value);
}

/**
 * Validate props for a composition.
 * @returns {string[]} human-readable errors; empty means valid.
 */
export function validateProps(compositionId, props) {
  const composition = COMPOSITIONS[compositionId];
  if (!composition) {
    const known = Object.keys(COMPOSITIONS).join(", ");
    return [`unknown composition "${compositionId}" (known: ${known})`];
  }
  if (!isPlainObject(props)) {
    return [`props: expected an object, got ${describe(props)}`];
  }

  const errors = [];
  checkFields(composition.props, props, [], errors);

  // Unknown keys are a warning-shaped error: usually a typo'd prop name that would
  // otherwise be silently ignored by React and produce a subtly wrong render.
  for (const key of Object.keys(props)) {
    if (!(key in composition.props)) {
      errors.push(`${key}: not a prop of ${compositionId} (typo? it would be silently ignored)`);
    }
  }
  return errors;
}

/**
 * Validate and throw on failure. Call this immediately before writing a props JSON,
 * so the failure lands before any encode or render cost is paid.
 */
export function assertValidProps(compositionId, props) {
  const errors = validateProps(compositionId, props);
  if (errors.length) {
    throw new Error(
      `Invalid props for ${compositionId} (${errors.length} problem${errors.length > 1 ? "s" : ""}):\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );
  }
}
