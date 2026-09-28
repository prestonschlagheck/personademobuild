import type { NextConfig } from "next";

// The policy leaves scripts, styles and connections alone: the call and analytics reach OpenAI and PostHog directly,
// and a wrong list there would break them silently. It only closes framing, base rewrites, plugins and forms posting
// off the site.
const CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The floating dev badge sits on top of the composer's + button in the phone layout.
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
