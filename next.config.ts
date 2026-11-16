import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native Node addon: keep it out of the Server Components
  // bundle and let it load via native require.
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    // Don't preload every route's module graph into memory when the dev
    // server starts — reduces the initial memory spike during `next dev`.
    preloadEntriesOnStart: false,
    // Only takes effect on the Webpack path (`next dev --webpack` /
    // `next build --webpack`); trades a little compile time for lower peak
    // memory. Harmless under Turbopack.
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
