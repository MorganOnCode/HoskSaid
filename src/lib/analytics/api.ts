/**
 * Request validation and responses for GET /api/analytics, /api/analytics/sources
 * and /api/analytics/rankings (server-only). Strict: bad input is a 400, never
 * silently ignored. All three are free (no model calls) and rate-limited.
 */
import type { NextRequest } from "next/server";
import { rateLimited } from "../ratelimit";
import { AnalyticsTimeoutError, getCoverage, getSources } from "./data";
import { MAX_SOURCE_PAGES, MAX_TERMS, parseYear, validateTerms } from "./params";
import { getArchiveYears, getRankingsPanel, resolveRange, type Range } from "./views";
import { METHOD } from "./method";

const MATCHING = "A video matches when its transcript or its title matches the query (Postgres websearch_to_tsquery('english'): words, \"exact phrases\", OR, -exclusions). YouTube tags are not counted. Counts are videos, never raw mentions.";

const bad = (error: string, detail: string) => Response.json({ error, detail }, { status: 400 });

function failed(e: unknown, where: string): Response {
  if (e instanceof AnalyticsTimeoutError) {
    return Response.json({ error: "query_timeout", detail: "The query took too long; try a more specific word or phrase." }, { status: 503, headers: { "Retry-After": "5" } });
  }
  console.error(`${where}:`, e);
  return Response.json({ error: "internal" }, { status: 500 });
}

const KNOWN = { coverage: ["q", "from", "to"], sources: ["q", "from", "to", "year", "page"], rankings: ["from", "to"] } as const;

function unknownParam(sp: URLSearchParams, allowed: readonly string[]): Response | null {
  for (const k of sp.keys()) if (!allowed.includes(k)) return bad("unknown_parameter", `unknown parameter ${k}; allowed: ${allowed.join(", ")}`);
  return null;
}

async function range(sp: URLSearchParams): Promise<{ range: Range } | { error: Response }> {
  const from = parseYear(sp.get("from") ?? undefined);
  const to = parseYear(sp.get("to") ?? undefined);
  if (from === undefined || to === undefined) return { error: bad("invalid_year", "from and to must be four-digit years") };
  if (from !== null && to !== null && from > to) return { error: bad("invalid_year", "from must not be after to") };
  const archive = await getArchiveYears();
  const r = resolveRange(archive, from, to);
  if (!r) return { error: Response.json({ error: "no_data", detail: "The archive has no dated videos yet." }, { status: 404 }) };
  return { range: r };
}

export async function coverageResponse(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const unknown = unknownParam(sp, KNOWN.coverage);
  if (unknown) return unknown;
  const v = validateTerms(sp.getAll("q"));
  if (!v.ok) return bad(v.error, v.detail);
  if (!v.terms.length) return bad("query_required", `pass 1 to ${MAX_TERMS} q parameters`);
  const limited = rateLimited(req, v.terms.length);
  if (limited) return limited;
  try {
    const r = await range(sp);
    if ("error" in r) return r.error;
    const terms = await getCoverage(v.terms, r.range.from, r.range.to);
    return Response.json({ range: r.range, matching: MATCHING, terms });
  } catch (e) {
    return failed(e, "GET /api/analytics");
  }
}

export async function sourcesResponse(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const unknown = unknownParam(sp, KNOWN.sources);
  if (unknown) return unknown;
  const v = validateTerms(sp.getAll("q"));
  if (!v.ok) return bad(v.error, v.detail);
  if (v.terms.length !== 1) return bad("query_required", "pass exactly one q parameter");
  const year = parseYear(sp.get("year") ?? undefined);
  if (year === undefined) return bad("invalid_year", "year must be a four-digit year");
  const rawPage = sp.get("page");
  const page = rawPage === null ? 1 : /^\d{1,3}$/.test(rawPage) ? parseInt(rawPage, 10) : NaN;
  if (!Number.isFinite(page) || page < 1 || page > MAX_SOURCE_PAGES) return bad("invalid_page", `page must be 1 to ${MAX_SOURCE_PAGES}`);
  const limited = rateLimited(req);
  if (limited) return limited;
  try {
    const r = await range(sp);
    if ("error" in r) return r.error;
    if (year !== null && (year < r.range.from || year > r.range.to)) return bad("invalid_year", "year must be inside from..to");
    const res = await getSources(v.terms[0], r.range.from, r.range.to, year, page);
    return Response.json({ range: r.range, matching: MATCHING, ...res });
  } catch (e) {
    return failed(e, "GET /api/analytics/sources");
  }
}

export async function rankingsResponse(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const unknown = unknownParam(sp, KNOWN.rankings);
  if (unknown) return unknown;
  const limited = rateLimited(req);
  if (limited) return limited;
  try {
    const r = await range(sp);
    if ("error" in r) return r.error;
    const panel = await getRankingsPanel(await getArchiveYears(), r.range);
    return Response.json({ method: METHOD, matching: MATCHING, ...panel });
  } catch (e) {
    return failed(e, "GET /api/analytics/rankings");
  }
}
