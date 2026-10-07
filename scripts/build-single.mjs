/**
 * 打包成「一个 HTML 文件」（开发脚本）
 *
 * 为什么需要：浏览器禁止 file:// 页面加载 ES 模块，所以正常的 Vite 产物
 * 必须挂在静态服务器上。这个脚本把 JS/CSS 全部内联成一个 IIFE 脚本，
 * 于是直接双击打开也能用（适合发给别人、或者本地离线使用）。
 *
 * 用法：pnpm build:single
 * 产物：dist-single/index.html（示例数据在 dist-single/sample/，用 file:// 打不开，
 *       点「试试示例」会提示改用「导入数据」，其余功能都正常）
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = 'dist-single';

rmSync(join(ROOT, OUT), { recursive: true, force: true });

await build({
  root: ROOT,
  configFile: false,
  base: './',
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
  logLevel: 'warn',
});

const htmlPath = join(ROOT, OUT, 'index.html');
let html = readFileSync(htmlPath, 'utf8');

const js = readFileSync(join(ROOT, OUT, 'app.js'), 'utf8');
let css = '';
try {
  css = readFileSync(join(ROOT, OUT, 'app.css'), 'utf8');
} catch {
  /* 没有单独样式文件时忽略 */
}

html = html
  .replace(/\s*<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/, '')
  .replace(/\s*<link[^>]*rel="stylesheet"[^>]*>/, '')
  .replace('</head>', `  <style>\n${css}\n  </style>\n</head>`)
  .replace('</body>', `  <script>\n${js}\n  </script>\n</body>`);

writeFileSync(htmlPath, html);

rmSync(join(ROOT, OUT, 'app.js'), { force: true });
rmSync(join(ROOT, OUT, 'app.css'), { force: true });

const kb = (readFileSync(htmlPath).length / 1024).toFixed(0);
console.log(`✓ 单文件版本已生成：${OUT}/index.html（${kb} KB）`);
console.log('  双击即可打开；示例数据按钮在 file:// 下不可用，其余功能正常。');
