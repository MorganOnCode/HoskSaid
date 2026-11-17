/**
 * Minimal TOON (Token-Oriented Object Notation) encoder for the operator CLI.
 * Covers what the CLI prints: nested objects, primitive arrays, and uniform
 * object arrays in tabular form. Strings are quoted whenever they could be
 * misread (delimiters, colons, leading/trailing space, number/bool/null look-alikes).
 */
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const NEEDS_QUOTES = /[,:"\\\n\r\t\[\]{}]|^\s|\s$|^-|^$/;
const LOOKS_LITERAL = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/;

export function scalar(v: Json): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  const s = String(v);
  if (NEEDS_QUOTES.test(s) || LOOKS_LITERAL.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  }
  return s;
}

function isPrimitive(v: Json): boolean {
  return v === null || typeof v !== "object";
}

function keyName(k: string): string {
  return /^[A-Za-z_][\w.]*$/.test(k) ? k : scalar(k);
}

function encodeValue(key: string, v: Json, indent: string, out: string[]): void {
  const k = keyName(key);
  if (isPrimitive(v)) {
    out.push(`${indent}${k}: ${scalar(v)}`);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.push(`${indent}${k}[0]:`);
      return;
    }
    if (v.every(isPrimitive)) {
      const inline = v.map(scalar).join(",");
      if (inline.length <= 100 && !v.some((x) => typeof x === "string" && x.length > 40)) {
        out.push(`${indent}${k}[${v.length}]: ${inline}`);
      } else {
        // Long strings (help text, notes) read best one per line.
        out.push(`${indent}${k}[${v.length}]:`);
        for (const item of v) out.push(`${indent}  ${typeof item === "string" ? item.replace(/\n/g, " ") : scalar(item)}`);
      }
      return;
    }
    const objs = v as { [k: string]: Json }[];
    const fields = Object.keys(objs[0] ?? {});
    const uniform =
      objs.every((o) => o && typeof o === "object" && !Array.isArray(o)) &&
      objs.every((o) => Object.keys(o).length === fields.length && fields.every((f) => f in o && isPrimitive(o[f])));
    if (uniform) {
      out.push(`${indent}${k}[${v.length}]{${fields.map(keyName).join(",")}}:`);
      for (const o of objs) out.push(`${indent}  ${fields.map((f) => scalar(o[f])).join(",")}`);
      return;
    }
    out.push(`${indent}${k}[${v.length}]:`);
    for (const item of v) {
      if (isPrimitive(item)) out.push(`${indent}  - ${scalar(item)}`);
      else {
        const lines: string[] = [];
        encodeObject(item as { [k: string]: Json }, `${indent}    `, lines);
        if (lines.length) lines[0] = `${indent}  - ${lines[0].trimStart()}`;
        out.push(...lines);
      }
    }
    return;
  }
  out.push(`${indent}${k}:`);
  encodeObject(v as { [k: string]: Json }, `${indent}  `, out);
}

function encodeObject(obj: { [k: string]: Json }, indent: string, out: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    encodeValue(k, v as Json, indent, out);
  }
}

/** Encode a top-level object as TOON text (no trailing newline). */
export function toToon(obj: Record<string, unknown>): string {
  const out: string[] = [];
  encodeObject(JSON.parse(JSON.stringify(obj)) as { [k: string]: Json }, "", out);
  return out.join("\n");
}
