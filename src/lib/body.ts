/**
 * Bounded JSON body reader. Next route handlers impose no default body limit,
 * so every POST that can trigger paid work reads at most `maxBytes`.
 */
export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; error: "invalid_body" | "body_too_large" | "unsupported_media_type" };

export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const type = request.headers.get("content-type") || "";
  if (type && !/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
    return { ok: false, status: 415, error: "unsupported_media_type" };
  }
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  if (!request.body) return { ok: false, status: 400, error: "invalid_body" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413, error: "body_too_large" };
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
}
