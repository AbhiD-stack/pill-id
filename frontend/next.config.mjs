import path from "node:path";
import { fileURLToPath } from "node:url";

// `npm run build:static` builds the app as plain files (frontend/out) that
// the backend serves itself, so the whole app runs from one address (e.g. a
// free Cloudflare tunnel). `npm run build` / `npm run dev` are unchanged.
const staticExport = process.env.npm_lifecycle_event === "build:static";
// This folder is the project (the repo root has a stray package-lock.json
// that otherwise makes Next.js resolve packages from the wrong folder).
// Not on Vercel: it passes its own root (the repo root) and fails the
// deploy ("lstat .next/package.json") if this overrides it.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const pinRoot = !process.env.VERCEL;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(pinRoot && { turbopack: { root: projectRoot }, outputFileTracingRoot: projectRoot }),
  ...(staticExport && {
    output: "export",
    trailingSlash: true,
    // Same address as the backend: call the API relative to the page.
    env: { NEXT_PUBLIC_SAME_ORIGIN: "1" },
  }),
};

export default nextConfig;
