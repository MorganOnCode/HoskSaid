import { parseArgs } from "../args";
import { emit, emitHelp, RUN, type Command } from "../runtime";
import { sql } from "../../lib/db";
import { applyMigrations, invalidIndexes, migrationStatus } from "../../lib/migrations";

const USAGE = `${RUN} migrate [status]                 list migrations and their state
${RUN} migrate apply [--dry-run] [--to <NNN>]   apply pending migrations in order
examples:
  ${RUN} migrate
  ${RUN} migrate apply --dry-run
  ${RUN} migrate apply --to 004`;

export const migrateCommand: Command = {
  name: "migrate",
  summary: "Show or apply versioned schema migrations (docker/migrations)",
  usage: USAGE,
  async run(argv) {
    const { positionals, flags } = parseArgs(argv, { "dry-run": "boolean", to: "string" }, USAGE);
    if (flags.help) {
      emit({ usage: USAGE });
      return 0;
    }
    const sub = positionals[0] ?? "status";
    if (sub === "status") {
      const status = await migrationStatus(sql);
      const invalid = await invalidIndexes(sql);
      const pending = status.filter((m) => m.state === "pending").length;
      emit({
        count: `${status.length} migrations, ${pending} pending`,
        migrations: status.map((m) => ({ version: m.version, name: m.name, state: m.state, tx: m.transactional })),
        ...(invalid.length ? { invalid_indexes: invalid } : {}),
      });
      const help = [];
      if (pending) help.push(`Run \`${RUN} migrate apply --dry-run\` to preview, then \`${RUN} migrate apply\``);
      if (invalid.length) help.push("An interrupted CONCURRENTLY build left an INVALID index: DROP INDEX CONCURRENTLY <name>, then re-run migrate apply");
      if (status.some((m) => m.state === "modified")) help.push("A modified migration is never re-applied; compare the file with what ran before changing anything");
      emitHelp(help);
      return 0;
    }
    if (sub === "apply") {
      const to = flags.to as string | undefined;
      if (to !== undefined && !/^\d{3}$/.test(to)) {
        emit({ error: "--to must be a three-digit version", help: USAGE });
        return 2;
      }
      const r = await applyMigrations(sql, { dryRun: !!flags["dry-run"], target: to });
      if (flags["dry-run"]) {
        emit({ dry_run: true, would_apply: r.pending, modified: r.modified });
        if (!r.pending.length) emit({ migrate: "nothing to apply (no-op)" });
        return 0;
      }
      emit({ applied: r.applied, modified: r.modified });
      if (!r.applied.length) emit({ migrate: "already up to date (no-op)" });
      return 0;
    }
    emit({ error: `unknown migrate subcommand ${sub}`, help: USAGE });
    return 2;
  },
};
