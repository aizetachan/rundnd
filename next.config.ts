import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Firebase App Hosting builds Next.js natively (Cloud Run under the
  // hood); no need for `output: "standalone"` here. Leaving it out also
  // keeps `next dev` faster locally.
  typedRoutes: false,
};

export default nextConfig;
