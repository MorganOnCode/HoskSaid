import { NextRequest } from "next/server";
import { rankingsResponse } from "@/lib/analytics/api";

export const dynamic = "force-dynamic";

/** GET /api/analytics/rankings?from=&to= → subjects, phrases, keywords and intro/sign-off patterns. Free (no model calls), rate-limited. */
export async function GET(request: NextRequest) {
  return rankingsResponse(request);
}
