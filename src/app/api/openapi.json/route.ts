import spec from "@/lib/contracts/openapi.json";

/** GET /api/openapi.json — the REST spec, served as application/json. */
export async function GET() {
  return new Response(JSON.stringify(spec, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
