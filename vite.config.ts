import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * React + Vite 构建配置
 *
 * 硬约束（与 vue-project / react-project 统一）：
 * - 约束 A：dev server 必须监听 3015 + strictPort（沙箱只开放一个代理端口）
 * - 约束 B：OSS 产物结构与 Webpack/Vue 模板完全一致
 *     - base './'             → HTML 引用相对路径（消费端 HomeController 能正确替换 link/script）
 *     - outDir 'dist'         → 归一化产物目录
 *     - assetsDir 'assets'    → 与 webpack HtmlWebpackPlugin 输出对齐
 *     - assetsInlineLimit 1MB → 方案 A：<=1MB 图片/字体内联为 dataURL
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.MEOO_PROXY_TARGET;
  const supabaseUrl = env.SUPABASE_PUBLIC_URL || env.SUPABASE_URL || process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL || '';
  const anonKey = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  process.env.VITE_SUPABASE_URL = supabaseUrl;
  process.env.VITE_SUPABASE_ANON_KEY = anonKey;

  return {
    plugins: [react()],
    assetsInclude: ['**/*.glb'],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(anonKey),
    },
    server: {
      host: '0.0.0.0',
      port: 3015,
      strictPort: true,
      allowedHosts: true,
      // HMR 默认关闭：沙箱预览 iframe 下 HMR 的整页 reload 会放大任何 transform error
      // 如需热更，改为: hmr: { clientPort: 443, protocol: 'wss' }
      hmr: false,
      ...(proxyTarget ? {
        proxy: {
          '/sb-api': {
            target: proxyTarget,
            changeOrigin: true,
            secure: true,
            headers: { 'X-Meoo-Source': 'local-dev' },
          },
        },
      } : {}),
    },
    base: './',
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      assetsInlineLimit: 1024 * 1024,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
