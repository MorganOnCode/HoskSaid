/**
 * Fake draft model for monthly-generation tests. It never calls a provider:
 * it answers each stage from the material in the prompt, quoting the source
 * wording so the evidence check can pass, and lets a test inject failures or
 * ungrounded statements per stage.
 */
import type { DraftModel } from "../../src/lib/digest/model";
import { FINAL_SYSTEM, NOTES_SYSTEM, REDUCE_SYSTEM } from "../../src/lib/digest/monthly";

export type Stage = "notes" | "reduce" | "final";

export interface FakeCall {
  stage: Stage;
  user: string;
}

export interface FakeOptions {
  /** Throw for this call (e.g. a provider outage). */
  fail?: (stage: Stage, user: string) => boolean;
  /** Replace the default reply. */
  reply?: (stage: Stage, user: string, def: unknown) => unknown;
  /** Delay each call (ms), for concurrency tests. */
  delayMs?: number;
  /** In the final stage, cite only the first N videos (forces "Also this month"). */
  finalVideos?: number;
  errorMessage?: string;
}

const words = (s: string, n: number) => s.split(/\s+/).slice(0, n).join(" ");

export function stageOf(system: string): Stage {
  if (system === NOTES_SYSTEM) return "notes";
  if (system === REDUCE_SYSTEM) return "reduce";
  if (system === FINAL_SYSTEM) return "final";
  throw new Error("unknown system prompt");
}

function defaultReply(stage: Stage, user: string, opts: FakeOptions): unknown {
  if (stage === "notes") {
    const timed = [...user.matchAll(/^\[(V\.\d+)\] at [\d:]+: (.+)$/gm)];
    if (timed.length) return { notes: timed.slice(0, 2).map((m) => ({ text: `Charles said ${words(m[2], 14)}`, cites: [m[1]] })) };
    const summary = /Summary \(AI-generated at ingestion; cite V\):\n(.+)/.exec(user);
    const excerpt = /^- (.+)$/m.exec(user);
    const text = summary?.[1] ?? excerpt?.[1] ?? "";
    return { notes: [{ text: `Charles said ${words(text.replace(/^[•\s-]+/, ""), 14)}`, cites: ["V"] }] };
  }
  const lines = [...user.matchAll(/^- (.+) \[([^\]]+)\]$/gm)].map((m) => ({ text: m[1], cites: m[2].split(", ") }));
  if (stage === "reduce") return { points: lines.slice(0, 50) };
  const byVideo = new Map<string, { text: string; cites: string[] }>();
  for (const l of lines) {
    const vid = l.cites[0].split(".")[0];
    if (!byVideo.has(vid)) byVideo.set(vid, l);
  }
  const picked = [...byVideo.values()].slice(0, opts.finalVideos ?? byVideo.size);
  return {
    title: "The month in review",
    dek: "What Charles covered this month.",
    intro: picked.slice(0, 1),
    sections: [{ heading: "Main themes", paragraphs: picked.slice(1).length ? picked.slice(1) : picked.slice(0, 1) }],
  };
}

export function fakeDraftModel(opts: FakeOptions = {}): DraftModel & { calls: FakeCall[]; byStage(s: Stage): number } {
  const calls: FakeCall[] = [];
  return {
    provider: "fake",
    model: "fake-1",
    calls,
    byStage: (s) => calls.filter((c) => c.stage === s).length,
    async complete({ system, user }) {
      const stage = stageOf(system);
      calls.push({ stage, user });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail?.(stage, user)) {
        const err = new Error(opts.errorMessage ?? "Incorrect API key provided: sk-test-SECRET123");
        (err as Error & { status: number }).status = 401;
        throw err;
      }
      const def = defaultReply(stage, user, opts);
      const r = opts.reply ? opts.reply(stage, user, def) : def;
      return typeof r === "string" ? r : JSON.stringify(r);
    },
  };
}
