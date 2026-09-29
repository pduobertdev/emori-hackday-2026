import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Bolt driver uses Node sockets; keep it out of the bundle and load it with require().
  serverExternalPackages: ["neo4j-driver"],
};

export default nextConfig;
