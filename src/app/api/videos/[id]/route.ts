import { NextRequest } from "next/server";
import { getVideoApi } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** GET /api/videos/{id} → the handoff video atom (chapters, topics, counts). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimited(request);
  if (limited) return limited;
  const { id } = await params;
  try {
    const video = await getVideoApi(id);
    if (!video) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(video);
  } catch (error) {
    console.error("GET /api/videos/[id]:", error);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
