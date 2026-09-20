import type { NextConfig } from "next";

export function buildContentSecurityPolicy(nodeEnv = process.env.NODE_ENV) {
  const developmentEval = nodeEnv === "development" ? " 'unsafe-eval'" : "";
  return `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'${developmentEval}; connect-src 'self'`;
}

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Content-Security-Policy", value: buildContentSecurityPolicy() },
      ],
    }];
  },
};

export default nextConfig;
