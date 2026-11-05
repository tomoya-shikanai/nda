import type { NextConfig } from "next";

/**
 * 開発サーバーに別の機械（工場の Pi など）から入るときの hostname。NDA_DEV_ORIGINS にカンマ区切りで書く
 * （scheme と port は付けない。例 `192.168.1.20,nda.local`）。既定は空（localhost だけ）。
 */
const devOrigins = (process.env.NDA_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  allowedDevOrigins: devOrigins,
};

export default nextConfig;
