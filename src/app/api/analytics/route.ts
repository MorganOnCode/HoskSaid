import { NextRequest } from "next/server";
import { coverageResponse } from "@/lib/analytics/api";

export const dynamic = "force-dynamic";

/** GET /api/analytics?q=&q=&from=&to= → per-year video coverage of up to three keyword queries. Free (no model calls), rate-limited. */
export async function GET(request: NextRequest) {
  return coverageResponse(request);
}
