/**
 * Visitor-selected answer engines (server-only). Stage 3 fills this in; until
 * then only the site engine exists and any explicit engine is rejected.
 */
import type { NextRequest } from "next/server";
import type { Synthesizer } from "./retrieval";

export type EngineResult =
  | { ok: true; synthesizer: Synthesizer | null }
  | { ok: false; error: string; message: string };

export function userSynthesizerFromRequest(_req: NextRequest, engine: unknown): EngineResult {
  if (engine === undefined || engine === null) return { ok: true, synthesizer: null };
  return { ok: false, error: "unsupported_engine", message: "Only the site engine is available." };
}
