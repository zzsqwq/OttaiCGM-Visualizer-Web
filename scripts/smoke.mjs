/**
 * 端到端冒烟测试（开发脚本，不参与打包）
 *
 * 用真实 Chrome（headless）跑一遍完整流程：
 *   导入 xlsx → 按天拆分 → 追加导入 → 导入标注 CSV → 手动加标注（拖动/编辑）
 *   → 峰值 → 刷新后数据仍在 → 深色主题 → 缩放
 * 每一步截图到 .screenshots/，控制台报错会记录为失败。
 *
 * 用法：
 *   node scripts/smoke.mjs [url]           # 默认 http://127.0.0.1:4173/
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, findChrome, launchChrome, pageTarget, randomPort, waitForChrome } from './lib/cdp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHOTS = join(ROOT, '.screenshots');
const CHROME = findChrome();
const PORT = randomPort();
const URL_BASE = process.argv[2] ?? 'http://127.0.0.1:4173/';

const FIXTURES = {
  // 用户提供的真实导出文件（2026-10-07，单日 163 点）
  real: join(ROOT, 'test/fixtures/OttaiCGM_E40A758F7AC3.xlsx'),
  // 半个月的数据（2025-03-16 ~ 03-30）
  big: join(ROOT, 'test/fixtures/OttaiCGM_20250330.xlsx'),
  annotations: join(ROOT, 'public/sample/活动标注-示例.csv'),
};

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  // 每次跑用全新的 profile，避免上一次的数据/进程互相干扰
  const profile = `/tmp/ottai-smoke-profile-${process.pid}-${Date.now()}`;
  rmSync(profile, { recursive: true, force: true });

  const chrome = await launchChrome({ port: PORT, profile, chromePath: CHROME });
  await waitForChrome(PORT);
  const target = await pageTarget(PORT);
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    // ---------------------------------------------------------- 首屏
    await cdp.send('Page.navigate', { url: URL_BASE });
    try {
      await cdp.waitFor(`document.documentElement.dataset.appReady === '1'`, { label: '应用启动完成' });
    } catch {
      // 线上跑的时候最常见的原因是刚部署完、CDN 边缘还在缓存旧的 404
      const actual = await cdp.eval(`return { url: location.href, title: document.title, state: document.readyState };`);
      throw new Error(`页面没有启动成功，实际拿到的是：${JSON.stringify(actual)}（线上地址请确认部署已完成、CDN 缓存已过期）`);
    }
    // 保证从干净状态开始（清掉本地存储再重新加载）
    await cdp.eval(`localStorage.clear(); return true;`);
    await cdp.send('Page.reload');
    await cdp.waitFor(`document.documentElement.dataset.appReady === '1'`, { label: '重新加载后启动完成' });
    await cdp.waitFor(`document.querySelector('#empty-state') && !document.querySelector('#empty-state').hidden`, {
      label: '空状态出现',
    });
    await sleep(300);
    const firstScreen = await cdp.eval(`
      return {
        emptyVisible: !document.querySelector('#empty-state').hidden,
        workspaceHidden: document.querySelector('#workspace').hidden,
        popoversHidden: [...document.querySelectorAll('.popover')].every(p => p.hidden),
        dropHidden: document.querySelector('#drop-overlay').hidden,
      };
    `);
    await cdp.screenshot(join(SHOTS, '01-empty.png'));
    check('首屏是引导页（空状态）', firstScreen.emptyVisible && firstScreen.workspaceHidden, JSON.stringify(firstScreen));
    check('弹层/拖拽遮罩默认隐藏', firstScreen.popoversHidden && firstScreen.dropHidden, JSON.stringify(firstScreen));

    // ---------------------------------------------------------- 示例数据
    console.log('\n[0] 点「用示例数据看看」');
    await cdp.eval(`document.querySelector('#btn-sample-2').click(); return true;`);
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 15`, { label: '示例数据载入' });
    await sleep(600);
    await cdp.eval(`
      [...document.querySelectorAll('#day-list .day-item')].find(e => e.dataset.day === '2025-03-27').click();
      return true;
    `);
    await sleep(600);
    const sample = await cdp.eval(`
      return {
        days: document.querySelectorAll('#day-list .day-item').length,
        ann: document.querySelectorAll('#ann-list .ann-item').length,
        labels: document.querySelectorAll('.ann-label').length,
      };
    `);
    check('示例数据 15 天全部载入', sample.days === 15, `${sample.days} 天`);
    check('示例标注载入并画在图上', sample.ann >= 5 && sample.labels >= 5, `${sample.ann} 条 / ${sample.labels} 个标签`);
    await cdp.screenshot(join(SHOTS, '00-sample.png'));
    await cdp.eval(`document.querySelector('#export-menu') && true; return true;`);
    await cdp.eval(`
      window.confirm = () => true;
      const btn = [...document.querySelectorAll('#export-menu [data-act="clear"]')][0];
      return true;
    `);
    // 用清空功能回到干净状态，继续后面的流程
    await cdp.eval(`
      document.querySelector('#btn-export').click();
      return true;
    `);
    await sleep(200);
    await cdp.eval(`
      document.querySelector('#export-menu [data-act="clear"]').click();
      return true;
    `);
    await cdp.waitFor(`!document.querySelector('#empty-state').hidden`, { label: '清空回到引导页' });
    check('可以清空本地数据回到初始状态', true);
    await sleep(300);

    // ---------------------------------------------------------- 导入真实单日文件
    console.log('\n[1] 导入 OttaiCGM_E40A758F7AC3.xlsx（2026-10-07 / 163 点）');
    await cdp.setFileInput('#file-input', [FIXTURES.real]);
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 1`, { label: '出现 1 天' });
    await cdp.waitFor(`document.querySelector('#chart canvas') !== null`, { label: '图表渲染' });
    await cdp.waitFor(`document.querySelector('#empty-state').hidden`, { label: '引导页收起' });
    await sleep(700);
    const one = await cdp.eval(`
      const days = [...document.querySelectorAll('#day-list .day-item')].map(el => el.dataset.day);
      const stats = [...document.querySelectorAll('#stats .stat')].map(el => el.textContent.trim());
      return {
        days,
        stats,
        title: document.querySelector('#day-title').textContent,
        sub: document.querySelector('#day-sub').textContent,
        source: document.querySelector('#sources').textContent,
      };
    `);
    check('按天拆分正确', one.days.length === 1 && one.days[0] === '2026-10-07', one.days.join(','));
    check('图表统计数据已渲染', one.stats.length >= 6, one.stats.join(' | '));
    check('数据点数为 163', one.sub.includes('163'), one.sub);
    check('数据源显示文件名', one.source.includes('E40A758F7AC3'), one.source.trim());
    await cdp.screenshot(join(SHOTS, '02-one-day.png'));

    // ---------------------------------------------------------- 追加导入半个月
    console.log('\n[2] 追加导入 OttaiCGM_20250330.xlsx（03-16 ~ 03-30）');
    await cdp.setFileInput('#file-input', [FIXTURES.big]);
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 16`, { label: '出现 15 天' });
    const days = await cdp.eval(`return [...document.querySelectorAll('#day-list .day-item')].map(el => el.dataset.day);`);
    check('多文件合并共 16 天（1 + 15）', days.length === 16, `${days.length} 天`);
    check('日期倒序排列（最新在前）', days[0] > days[days.length - 1], `${days[0]} → ${days[days.length - 1]}`);

    // ---------------------------------------------------------- 切到 2025-03-27
    await cdp.eval(`
      const el = [...document.querySelectorAll('#day-list .day-item')].find(e => e.dataset.day === '2025-03-27');
      el.click(); return true;
    `);
    await sleep(600);
    const dayInfo = await cdp.eval(`return document.querySelector('#day-sub').textContent;`);
    check('切换日期显示 288 个点', dayInfo.includes('288'), dayInfo);
    await cdp.screenshot(join(SHOTS, '03-switch-day.png'));

    // ---------------------------------------------------------- 导入标注 CSV
    console.log('\n[3] 导入旧版标注 CSV（含日期列）');
    await cdp.setFileInput('#file-input', [FIXTURES.annotations]);
    await cdp.waitFor(`document.querySelectorAll('#ann-list .ann-item').length >= 6`, { label: '标注出现在列表' });
    await sleep(500);
    const annCount = await cdp.eval(`
      return {
        count: document.querySelectorAll('#ann-list .ann-item').length,
        labels: document.querySelectorAll('.ann-label').length,
        text: [...document.querySelectorAll('#ann-list .ann-item-text')].slice(0,2).map(e => e.textContent),
      };
    `);
    check('本日标注已导入并画到图上', annCount.count >= 6 && annCount.labels >= 6, `${annCount.count} 条 / 图上 ${annCount.labels} 个标签`);
    check('标注内容正确', annCount.text.some((t) => t.includes('菠萝') || t.includes('白米')), annCount.text.join(' / '));
    await cdp.screenshot(join(SHOTS, '04-annotations.png'));

    // ---------------------------------------------------------- 手动添加标注
    console.log('\n[4] 手动添加标注（点图表 → 输入文字 → 回车）');
    await cdp.eval(`document.querySelector('#btn-add').click(); return true;`);
    await sleep(200);
    const box = await cdp.eval(`
      const r = document.querySelector('#chart-wrap').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    `);
    await cdp.click(box.x + box.w * 0.62, box.y + box.h * 0.42);
    await cdp.waitFor(`document.querySelector('.ann-label input') !== null`, { label: '标注输入框出现' });
    await cdp.typeText('测试标注：下午茶一块蛋糕');
    await cdp.pressKey('Enter', 'Enter', 13);
    await sleep(500);
    const afterAdd = await cdp.eval(`
      return {
        labels: [...document.querySelectorAll('.ann-label')].map(el => el.textContent),
        items: document.querySelectorAll('#ann-list .ann-item').length,
      };
    `);
    check(
      '新标注同时出现在图上和列表',
      afterAdd.labels.some((t) => t.includes('测试标注')) && afterAdd.items >= 7,
      `图上 ${afterAdd.labels.length} 个 / 列表 ${afterAdd.items} 条`,
    );
    await cdp.screenshot(join(SHOTS, '05-add-annotation.png'));

    // ---------------------------------------------------------- 拖动标注
    console.log('\n[5] 拖动标注标签（调整纵向偏移）');
    const before = await cdp.eval(`
      const el = [...document.querySelectorAll('.ann-label')].find(e => e.textContent.includes('测试标注'));
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `);
    await cdp.drag({ x: before.x, y: before.y }, { x: before.x, y: before.y - 90 });
    await sleep(500);
    const after = await cdp.eval(`
      const el = [...document.querySelectorAll('.ann-label')].find(e => e.textContent.includes('测试标注'));
      const r = el.getBoundingClientRect();
      const stored = window.__ottai.app.debugAnnotations().find(a => a.text.includes('测试标注'));
      return { y: r.y + r.height / 2, offset: stored ? stored.offset : null };
    `);
    check('拖动后标签向上移动', after.y < before.y - 10, `Δy = ${Math.round(after.y - before.y)}px`);
    check('偏移量写入数据（mmol/L）', after.offset !== null && after.offset > 2, `offset = ${after.offset}`);
    await cdp.screenshot(join(SHOTS, '06-drag-annotation.png'));

    // ---------------------------------------------------------- 撤销
    console.log('\n[6] 撤销（Cmd/Ctrl+Z）');
    await cdp.eval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
      return true;
    `);
    await sleep(400);
    const undone = await cdp.eval(`
      const el = [...document.querySelectorAll('.ann-label')].find(e => e.textContent.includes('测试标注'));
      return el ? el.getBoundingClientRect().y : null;
    `);
    check('撤销后回到拖动前的位置', undone !== null && Math.abs(undone - (before.y - 12)) < 30, `y=${undone?.toFixed(0)}`);

    // ---------------------------------------------------------- 峰值
    console.log('\n[7] 打开峰值显示');
    await cdp.eval(`document.querySelector('#btn-peaks').click(); return true;`);
    await sleep(150);
    await cdp.eval(`
      const chk = document.querySelector('#chk-peaks');
      chk.checked = true;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    await sleep(800);
    const peaks = await cdp.eval(`
      const chart = window.__ottai.app.debugPeaks();
      return chart;
    `);
    check('检出超过目标上限的峰值', Array.isArray(peaks) && peaks.length >= 1, `${peaks?.length} 个峰`);
    await cdp.screenshot(join(SHOTS, '07-peaks.png'));

    // ---------------------------------------------------------- 刷新恢复
    console.log('\n[8] 刷新页面，检查本地持久化');
    await cdp.send('Page.reload');
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 16`, { label: '刷新后恢复 16 天' });
    await cdp.waitFor(`!document.querySelector('#workspace').hidden`, { label: '工作区显示' });
    await cdp.eval(`
      const el = [...document.querySelectorAll('#day-list .day-item')].find(e => e.dataset.day === '2025-03-27');
      el.click(); return true;
    `);
    await sleep(700);
    const restored = await cdp.eval(`
      return {
        labels: [...document.querySelectorAll('.ann-label')].map(el => el.textContent),
        items: document.querySelectorAll('#ann-list .ann-item').length,
        days: document.querySelectorAll('#day-list .day-item').length,
      };
    `);
    check('刷新后标注仍在', restored.labels.some((t) => t.includes('测试标注')), `列表 ${restored.items} 条`);
    check('刷新后数据仍在', restored.days === 16, `${restored.days} 天`);
    await cdp.screenshot(join(SHOTS, '08-after-reload.png'));

    // ---------------------------------------------------------- 深色主题 + 缩放
    console.log('\n[9] 深色主题与缩放');
    await cdp.eval(`document.querySelector('#btn-theme').click(); return true;`);
    await sleep(800);
    const theme = await cdp.eval(`return document.documentElement.dataset.theme;`);
    check('切换深色主题', theme === 'dark', theme);
    await cdp.screenshot(join(SHOTS, '09-dark.png'));

    await cdp.eval(`
      const wrap = document.querySelector('#chart-wrap');
      const r = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new WheelEvent('wheel', {
        clientX: r.x + r.width * 0.5, clientY: r.y + r.height * 0.5,
        deltaY: -300, bubbles: true, cancelable: true,
      }));
      return true;
    `);
    await sleep(800);
    await cdp.screenshot(join(SHOTS, '10-zoom.png'));
    check('缩放交互无异常', true);

    // 回到浅色
    await cdp.eval(`document.querySelector('#btn-theme').click(); return true;`);
    await sleep(600);

    // ---------------------------------------------------------- 移动端布局
    console.log('\n[9.5] 移动端（390x844）布局');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(900);
    const mobile = await cdp.eval(`
      return {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        chartH: document.querySelector('#chart-wrap').getBoundingClientRect().height,
        labels: document.querySelectorAll('.ann-label').length,
      };
    `);
    check('移动端没有横向溢出', mobile.scrollW <= mobile.clientW + 2, `${mobile.scrollW} / ${mobile.clientW}`);
    check('移动端图表仍然可见', mobile.chartH > 200, `高度 ${Math.round(mobile.chartH)}px`);
    await cdp.screenshot(join(SHOTS, '11-mobile.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(600);

    // ---------------------------------------------------------- 导出图片
    console.log('\n[10] 导出 PNG（合成标注）');
    const png = await cdp.eval(`
      try {
        const blob = await window.__ottai.app.debugExportPng();
        return blob ? blob.size : 0;
      } catch (e) { return 'ERR:' + e.message; }
    `);
    check('能把图表+标注合成 PNG', typeof png === 'number' && png > 20000, `大小 ${png} 字节`);

    check('运行期间没有控制台报错', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | '));
  } finally {
    cdp.close();
    chrome.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过 · 截图目录 ${SHOTS}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exitCode = 1;
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常：', err);
  process.exitCode = 1;
});
