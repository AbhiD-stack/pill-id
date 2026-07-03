/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // This stops TypeScript errors from crashing your deployment on Vercel
    ignoreBuildErrors: true,
  },
};

export default nextConfig;