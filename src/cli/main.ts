import { VERSION } from "./version";
import { UsageError } from "./args";
import { binPath, closeDb, emit, loadEnv, reportError, RUN, type Command } from "./runtime";
import { migrateCommand } from "./commands/migrate";
import { coverageCommand, usageCommand, homeSummary } from "./commands/status";

const COMMANDS: Command[] = [migrateCommand, coverageCommand, usageCommand];

export async function main(argv: string[]): Promise<number> {
  loadEnv();
  try {
    if (argv.length === 0) {
      emit({ bin: binPath(), description: "Operator CLI for thehosksaid: schema migrations, coverage, usage caps, monthly posts and the weekly newsletter", version: VERSION });
      emit(await homeSummary());
      emit({
        commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary })),
        help: [`Run \`${RUN} <command> --help\` for flags and examples`],
      });
      return 0;
    }
    if (argv[0] === "--help" || argv[0] === "help") {
      emit({ usage: `${RUN} <command> [flags]`, commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary })) });
      return 0;
    }
    const cmd = COMMANDS.find((c) => c.name === argv[0]);
    if (!cmd) {
      throw new UsageError(`unknown command ${argv[0]}`, `commands: ${COMMANDS.map((c) => c.name).join(", ")}`);
    }
    return await cmd.run(argv.slice(1));
  } catch (e) {
    return reportError(e);
  } finally {
    await closeDb();
  }
}
