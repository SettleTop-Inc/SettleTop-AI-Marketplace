import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo sits under a parent directory that carries its own unrelated
  // package-lock.json, so Next infers that parent as the workspace root and
  // traces every sibling project into the build. Pin the root to this project.
  outputFileTracingRoot: path.join(__dirname),
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
