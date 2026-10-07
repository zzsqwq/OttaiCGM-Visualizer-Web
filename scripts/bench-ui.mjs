/**
 * 交互性能基准（开发用）
 *
 * 先生成一份「一年 / 10.5 万个点」的合成数据，导入后测量日常操作的主线程耗时：
 *   - 切换日期（日期列表 + 统计 + 图表重绘）
 *   - 选中标注（列表与图上的选中态）
 *   - 鼠标扫图（tooltip 与轴指示线连续重绘）
 * 用来防止后续改动把交互性能改坏。
 *
 * 用法：node scripts/bench-ui.mjs [url]
 *   url 默认 http://127.0.0.1:4173/
 */
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDP, findChrome, launchChrome, pageTarget, randomPort, waitForChrome } from './lib/cdp.mjs';

const CHROME = findChrome();
const PORT = randomPort(18000, 400);
const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成 365 天、每 5 分钟一个点的合成数据 */
function makeYearCsv(days = 365) {
  const rows = ['日期,时间,血糖值mmol/L'];
  const start = Date.UTC(2025, 0, 1);
  for (let d = 0; d < days; d++) {
    const date = new Date(start + d * 86400000);
    const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    for (let i = 0; i < 288; i++) {
      const minutes = i * 5;
      const h = String(Math.floor(minutes / 60)).padStart(2, '0');
      const m = String(minutes % 60).padStart(2, '0');
      const base = 5.6 + 0.9 * Math.sin((minutes / 1440) * Math.PI * 6 + d * 0.7);
      const meal =
        1.9 * Math.exp(-((minutes - 720) ** 2) / (2 * 55 ** 2)) + 1.6 * Math.exp(-((minutes - 1140) ** 2) / (2 * 50 ** 2));
      const v = Math.max(3, Math.min(14, base + meal + Math.sin(d * 12.9898 + i) * 0.18));
      rows.push(`${day},${h}:${m},${v.toFixed(1)}`);
    }
  }
  const file = join(tmpdir(), `ottai-bench-${days}d.csv`);
  writeFileSync(file, rows.join('\n'));
  return file;
}

const csvFile = makeYearCsv();
const profile = `/tmp/ottai-bench-ui-${process.pid}-${Date.now()}`;
rmSync(profile, { recursive: true, force: true });

const chrome = await launchChrome({ port: PORT, profile, chromePath: CHROME });
await waitForChrome(PORT);
const cdp = await CDP.connect((await pageTarget(PORT)).webSocketDebuggerUrl);

async function taskMs() {
  const res = await cdp.send('Performance.getMetrics');
  const map = {};
  for (const m of res.metrics) map[m.name] = m.value;
  return map.TaskDuration * 1000;
}
const report = (label, ms, times) =>
  console.log(`${label.padEnd(16)} ${String(Math.round(ms)).padStart(6)}ms / ${times} 次 · 每次 ${(ms / times).toFixed(2)}ms`);

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Performance.enable');
  await cdp.send('Page.navigate', { url: URL_BASE });
  await cdp.waitFor(`document.documentElement.dataset.appReady === '1'`, { label: '应用启动' });
  await cdp.eval(`localStorage.clear(); return true;`);
  await cdp.send('Page.reload');
  await cdp.waitFor(`document.documentElement.dataset.appReady === '1'`, { label: '重新加载' });

  const t0 = Date.now();
  await cdp.setFileInput('#file-input', [csvFile]);
  await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length >= 300`, {
    timeout: 60000,
    label: '导入一年数据',
  });
  console.log(`数据导入：365 天，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await sleep(800);

  await cdp.eval(`document.querySelectorAll('#day-list .day-item')[5].click(); return true;`);
  await sleep(500);
  await cdp.eval(`
    for (let i = 0; i < 6; i++) window.__ottai.app.debugAddAnnotationAt(i * 120 + 240, '基准标注 ' + i);
    return true;
  `);
  await sleep(600);

  let a = await taskMs();
  for (let i = 0; i < 20; i++) {
    await cdp.eval(`
      const days = [...document.querySelectorAll('#day-list .day-item')];
      days[(${i} * 17) % days.length].click();
      return true;
    `);
    await sleep(60);
  }
  await sleep(300);
  report('切换日期 ×20', (await taskMs()) - a, 20);

  a = await taskMs();
  for (let i = 0; i < 20; i++) {
    await cdp.eval(`
      const items = [...document.querySelectorAll('#ann-list .ann-item')];
      if (items.length) items[${i} % items.length].click();
      return true;
    `);
    await sleep(50);
  }
  await sleep(300);
  report('选中标注 ×20', (await taskMs()) - a, 20);

  const box = await cdp.eval(`
    const r = document.querySelector('#chart-wrap').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  `);
  const cy = box.y + box.h * 0.55;
  a = await taskMs();
  for (let i = 0; i < 120; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 60 + ((box.w - 120) * i) / 120, y: cy });
    await sleep(8);
  }
  report('鼠标扫图 ×120', (await taskMs()) - a, 120);
} finally {
  cdp.close();
  chrome.kill();
}
process.exit(0);
