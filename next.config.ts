import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security";

const nextConfig: NextConfig = {
  // Standalone output bundles only the runtime dependencies Next traces from
  // route handlers, so the production image stays small. Required for the
  // `node server.js` start command in the Dockerfile.
  output: "standalone",
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }];
  },

  // Adopt the handoff routes; preserve old URLs with permanent redirects.
  async redirects() {
    return [
      { source: "/videos", destination: "/library", permanent: true },
      { source: "/videos/:id", destination: "/video/:id", permanent: true },
      { source: "/search", destination: "/library", permanent: true },
    ];
  },
};

export default nextConfig;
