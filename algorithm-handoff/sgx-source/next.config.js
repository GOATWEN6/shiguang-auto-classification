/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  images: {
    domains: [],
  },
  // 支持绝对导入路径
  experimental: {
    // 保留 ws 在 Node.js 中对可选原生组件的正常加载与回退。
    // Webpack 的 ignored 空模块会让已安装的 ws 在发送 ASR 首包时失败。
    serverComponentsExternalPackages: ['ws'],
    serverActions: {
      allowedOrigins: ['localhost:3000'],
    },
  },
};

module.exports = nextConfig;
