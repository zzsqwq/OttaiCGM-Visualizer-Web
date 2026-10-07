/**
 * 生成 README 用的界面截图（开发脚本）
 *
 * 用法：node scripts/screenshots.mjs [url]
 * 产物：docs/preview-light.png、docs/preview-dark.png、docs/preview-mobile.png、docs/export-example.png
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, findChrome, launchChrome, pageTarget, randomPort, waitForChrome } from './lib/cdp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'docs');
const CHROME = findChrome();
const PORT = randomPort(9700);
const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const profile = `/tmp/ottai-shots-profile-${process.pid}`;
rmSync(profile, { recursive: true, force: true });

const chrome = await launchChrome({ port: PORT, profile, chromePath: CHROME });
await waitForChrome(PORT);
const target = await pageTarget(PORT);
const cdp = await CDP.connect(target.webSocketDebuggerUrl);

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.navigate', { url: URL_BASE });
  await cdp.waitFor(`document.documentElement.dataset.appReady === '1'`);
  await cdp.eval(`localStorage.clear(); return true;`);

  // 直接用示例数据（等价于点「用示例数据看看」）
  await cdp.eval(`document.querySelector('#btn-sample-2').click(); return true;`);
  await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 15`);
  await cdp.eval(`
    [...document.querySelectorAll('#day-list .day-item')].find(e => e.dataset.day === '2025-03-27').click();
    return true;
  `);
  await sleep(1000);
  // 打开峰值，展示自动标注效果
  await cdp.eval(`document.querySelector('#btn-peaks').click(); return true;`);
  await sleep(150);
  await cdp.eval(`
    const chk = document.querySelector('#chk-peaks');
    chk.checked = true;
    chk.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await cdp.eval(`document.body.click(); return true;`); // 收起弹层
  await sleep(5200); // 等提示条消失

  await cdp.screenshot(join(OUT, 'preview-light.png'));
  console.log('✓ docs/preview-light.png');

  // 导出图片示例
  const b64 = await cdp.eval(`
    const blob = await window.__ottai.app.debugExportPng();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  `);
  writeFileSync(join(OUT, 'export-example.png'), Buffer.from(b64, 'base64'));
  console.log('✓ docs/export-example.png');

  // 深色
  await cdp.eval(`document.querySelector('#btn-theme').click(); return true;`);
  await sleep(1200);
  await cdp.screenshot(join(OUT, 'preview-dark.png'));
  console.log('✓ docs/preview-dark.png');
  await cdp.eval(`document.querySelector('#btn-theme').click(); return true;`);
  await sleep(800);

  // 移动端
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 900,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(1200);
  await cdp.eval(`window.scrollTo(0, 240); return true;`);
  await sleep(600);
  await cdp.screenshot(join(OUT, 'preview-mobile.png'));
  console.log('✓ docs/preview-mobile.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
} finally {
  cdp.close();
  chrome.kill();
}

console.log(`\n截图已输出到 ${OUT}`);
process.exit(0);
