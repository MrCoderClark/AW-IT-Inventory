import type { NextConfig } from "next";

// Since proxy.ts now runs on /api (so API requests refresh the auth cookie like
// page navigations), large uploads flow THROUGH the proxy, which caps the request
// body at 10MB by default. Raise that cap to the software-installer upload limit
// (SOFTWARE_MAX_UPLOAD_BYTES, default 300MB) plus headroom for multipart overhead,
// so uploading an MSI/EXE installer isn't truncated. (Next 16: proxyClientMaxBodySize,
// formerly middlewareClientMaxBodySize.)
const UPLOAD_LIMIT_MB =
  Math.ceil(
    Number(process.env.SOFTWARE_MAX_UPLOAD_BYTES ?? 300 * 1024 * 1024) /
      (1024 * 1024),
  ) + 16;

const nextConfig: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: `${UPLOAD_LIMIT_MB}mb`,
  },
};

export default nextConfig;
