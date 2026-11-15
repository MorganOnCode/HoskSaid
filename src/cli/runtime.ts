/** Shared CLI plumbing: output, errors, env loading, DB lifecycle. */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toToon } from "./toon";
import { UsageError } from "./args";

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(argv: string[]): Promise<number>;
}

export function emit(obj: Record<string, unknown>): void {
  // Multi-line help text reads better as a list than as one escaped string.
  const out = { ...obj };
  if (typeof out.help === "string" && out.help.includes("\n")) out.help = out.help.split("\n");
  if (typeof out.usage === "string" && out.usage.includes("\n")) out.usage = out.usage.split("\n");
  process.stdout.write(toToon(out) + "\n");
}

export function emitHelp(lines: string[]): void {
  if (lines.length) emit({ help: lines });
}

export class CliError extends Error {
  constructor(message: string, readonly help?: string, readonly code = 1) {
    super(message);
    this.name = "CliError";
  }
}

/** Translate any failure into structured stdout + exit code (never a stack trace). */
export function reportError(e: unknown): number {
  if (e instanceof UsageError) {
    emit({ error: e.message, ...(e.help ? { help: e.help } : {}) });
    return 2;
  }
  if (e instanceof CliError) {
    emit({ error: e.message, ...(e.help ? { help: e.help } : {}) });
    return e.code;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/DATABASE_URL is not set/.test(msg)) {
    emit({ error: "database not configured", help: "Set DATABASE_URL (or put it in .env) and retry" });
    return 1;
  }
  if (/ECONNREFUSED|ENOTFOUND|getaddrinfo|password authentication|connect ETIMEDOUT/i.test(msg)) {
    emit({ error: "database unreachable", help: "Check DATABASE_URL and that Postgres is running (from a laptop: ssh -L 5432:127.0.0.1:5432 <vps>)" });
    return 1;
  }
  emit({ error: msg.split("\n")[0].slice(0, 300) });
  return 1;
}

export function loadEnv(): void {
  const file = path.join(process.cwd(), ".env");
  if (existsSync(file) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(file);
    } catch {
      /* ignore malformed .env; explicit env still applies */
    }
  }
}

export function binPath(): string {
  const p = path.join(process.cwd(), "src", "cli", "hosk.ts");
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export async function closeDb(): Promise<void> {
  const g = globalThis as { __hosksaidPg?: { end(o: { timeout: number }): Promise<void> } };
  await g.__hosksaidPg?.end({ timeout: 2 }).catch(() => {});
}

export const RUN = "npx tsx src/cli/hosk.ts";
