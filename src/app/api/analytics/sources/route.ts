import { NextRequest } from "next/server";
import { sourcesResponse } from "@/lib/analytics/api";

export const dynamic = "force-dynamic";

/** GET /api/analytics/sources?q=&from=&to=&year=&page= → matching videos with excerpts and links. Free (no model calls), rate-limited. */
export async function GET(request: NextRequest) {
  return sourcesResponse(request);
}
