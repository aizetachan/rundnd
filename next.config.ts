import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Firebase App Hosting builds Next.js natively (Cloud Run under the
  // hood); no need for `output: "standalone"` here.
  typedRoutes: false,
  // Force the @anthropic-ai/claude-agent-sdk native binary to be
  // included in the server bundle. Without this, Next's output-file
  // tracer doesn't see the binary as a referenced file (it's spawned
  // via child_process at runtime, not imported), and App Hosting
  // ships an image where node_modules/.pnpm/...claude-agent-sdk-
  // linux-x64.../claude is missing — runtime then throws "Native CLI
  // binary for linux-x64 not found".
  outputFileTracingIncludes: {
    "*": [
      "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64-musl@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
    ],
  },
};

export default nextConfig;
