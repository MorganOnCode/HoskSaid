#!/usr/bin/env -S npx tsx
/**
 * hosk — operator CLI for thehosksaid (schema migrations, archive coverage,
 * site-funded usage caps, monthly blog drafts). Run on a host with DATABASE_URL set:
 *   npx tsx src/cli/hosk.ts <command> ...
 * Output is TOON on stdout; progress/diagnostics go to stderr.
 */
import { VERSION } from "./version";

const argv = process.argv.slice(2);
if (argv.length === 1 && ["-v", "-V", "--version"].includes(argv[0])) {
  process.stdout.write(`${VERSION}\n`);
} else {
  void (async () => {
    const { main } = await import("./main");
    process.exitCode = await main(argv);
  })();
}
