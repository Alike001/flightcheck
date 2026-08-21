import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // The package build runs strict tsc immediately before Next.js. This avoids
    // Next 16.3.2 reparsing TypeScript 6 --showConfig after the real check passes.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
