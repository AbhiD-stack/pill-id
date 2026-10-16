// `npm run build:static` builds the app as plain files (frontend/out) that
// the backend serves itself, so the whole app runs from one address (e.g. a
// free Cloudflare tunnel). `npm run build` / `npm run dev` are unchanged.
const staticExport = process.env.npm_lifecycle_event === "build:static";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(staticExport && {
    output: "export",
    trailingSlash: true,
    // Same address as the backend: call the API relative to the page.
    env: { NEXT_PUBLIC_SAME_ORIGIN: "1" },
  }),
};

export default nextConfig;
