import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo sits under a parent directory that carries its own unrelated
  // package-lock.json, so Next infers that parent as the workspace root and
  // traces every sibling project into the build. Pin the root to this project.
  outputFileTracingRoot: path.join(__dirname),
  // The product was renamed from AI Marketplace to AI Registry, and its
  // /products slug moved with it. The old URL is published, so it redirects
  // rather than 404ing.
  async redirects() {
    return [
      {
        source: "/products/ai-marketplace",
        destination: "/products/ai-registry",
        permanent: true,
      },
      // The browsing tool moved from /marketplace to /registry. Both the
      // index and its compare view are published and shared by link, and
      // Next carries the query string across, so a saved result set or a
      // compare selection survives the move.
      { source: "/marketplace", destination: "/registry", permanent: true },
      {
        source: "/marketplace/:path*",
        destination: "/registry/:path*",
        permanent: true,
      },
    ];
  },
  // Listing imagery is served from Microsoft's CDNs. Only hosts we have
  // actually seen in captured data are allowed.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.microsoft.com" },
      { protocol: "https", hostname: "**.azureedge.net" },
      { protocol: "https", hostname: "**.windows.net" },
    ],
  },
};

export default nextConfig;
