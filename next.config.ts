import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project: a stray lockfile in a parent
  // directory (outside this repo) otherwise makes Next.js guess wrong.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
