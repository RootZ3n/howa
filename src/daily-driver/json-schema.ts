import { readFileSync } from "node:fs";

type Schema = Record<string, unknown>;

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function typeMatches(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return object(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function walk(schema: Schema, value: unknown, root: Schema, at: string, issues: string[]): void {
  if (typeof schema.$ref === "string") {
    const parts = schema.$ref.replace(/^#\//, "").split("/");
    let target: unknown = root;
    for (const part of parts) target = object(target) ? target[part] : undefined;
    if (!object(target)) { issues.push(`${at}: unresolved schema reference ${schema.$ref}`); return; }
    walk(target, value, root, at, issues); return;
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((branch) => { const nested: string[] = []; if (object(branch)) walk(branch, value, root, at, nested); return nested.length === 0; })) issues.push(`${at}: no anyOf branch matched`);
    return;
  }
  if ("const" in schema && value !== schema.const) issues.push(`${at}: const mismatch`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) issues.push(`${at}: value is not in enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeof type === "string" && typeMatches(value, type))) { issues.push(`${at}: type mismatch`); return; }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push(`${at}: string too short`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) issues.push(`${at}: pattern mismatch`);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) issues.push(`${at}: invalid date-time`);
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) issues.push(`${at}: below minimum`);
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push(`${at}: too few items`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) issues.push(`${at}: duplicate items`);
    if (object(schema.items)) value.forEach((item, index) => walk(schema.items as Schema, item, root, `${at}[${index}]`, issues));
  }
  if (object(value)) {
    const properties = object(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === "string" && !(key in value)) issues.push(`${at}.${key}: required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) issues.push(`${at}.${key}: additional property`);
    for (const [key, propertySchema] of Object.entries(properties)) if (key in value && object(propertySchema)) walk(propertySchema, value[key], root, `${at}.${key}`, issues);
  }
}

let cached: Schema | null = null;
export function validateCommittedReceiptSchema(value: unknown): string[] {
  cached ??= JSON.parse(readFileSync(new URL("../../schemas/howa-hermes-daily-driver-receipt.v2.schema.json", import.meta.url), "utf8")) as Schema;
  const issues: string[] = [];
  walk(cached, value, cached, "$", issues);
  return issues;
}
