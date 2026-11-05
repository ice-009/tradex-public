import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Fyers SDK is a CommonJS Node package (native-ish deps, ws, jsonwebtoken,
  // obfuscated HSM binary parser). Keep it out of the Server Components bundle
  // and let it load via native require, like better-sqlite3/prisma above.
  serverExternalPackages: ["fyers-api-v3", "better-sqlite3"],
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
