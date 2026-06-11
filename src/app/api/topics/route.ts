import { NextRequest } from "next/server";
import { listTopicsApi } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** GET /api/topics → all clustered topics with counts. */
export async function GET(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;
  try {
    const items = await listTopicsApi();
    return Response.json({ items });
  } catch (error) {
    console.error("GET /api/topics:", error);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
