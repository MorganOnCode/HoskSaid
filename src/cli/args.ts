/** Strict flag parsing for the operator CLI: unknown flags are errors, never ignored. */
export class UsageError extends Error {
  constructor(message: string, readonly help?: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  /** flag name without dashes -> "boolean" or "string" */
  [name: string]: "boolean" | "string";
}

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[], spec: FlagSpec, usage: string, renamed: Record<string, string> = {}): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    if (rawName === "help") {
      flags.help = true;
      continue;
    }
    if (renamed[rawName]) throw new UsageError(`--${rawName} was renamed; use --${renamed[rawName]} instead`, usage);
    const kind = spec[rawName];
    if (!kind) {
      const valid = Object.keys(spec).map((f) => `--${f}`).join(", ") || "(none)";
      throw new UsageError(`unknown flag --${rawName}`, `valid flags: ${valid} (--help always allowed)\n${usage}`);
    }
    if (kind === "boolean") {
      if (inline !== undefined) throw new UsageError(`--${rawName} takes no value`, usage);
      flags[rawName] = true;
    } else {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError(`--${rawName} requires a value`, usage);
      }
      flags[rawName] = value;
    }
  }
  return { positionals, flags };
}
