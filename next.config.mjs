/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Tool loop streams can take >30s on slow/long tool chains.
    // Keep the default action timeout comfortable.
  },
};

export default nextConfig;
