import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles only the runtime dependencies Next traces from
  // route handlers, so the production image stays small. Required for the
  // `node server.js` start command in the Dockerfile.
  output: "standalone",
};

export default nextConfig;
