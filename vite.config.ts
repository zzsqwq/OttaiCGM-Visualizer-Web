import { defineConfig } from 'vitest/config';

// 纯静态部署：使用相对路径，可放到 GitHub Pages / 任意子目录 / 本地静态服务器
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // 图表库和表格解析库分包，首屏 JS 更小、更新缓存更稳
        manualChunks: {
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
          xlsx: ['xlsx'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
