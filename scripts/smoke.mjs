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

    // 页面里的 window.confirm 会阻塞渲染进程（headless 下没人点），统一自动确认
    cdp.ws.on('message', (text) => {
      const msg = JSON.parse(text);
      if (msg.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
      }
    });

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

    const opensource = await cdp.eval(`
      const link = document.querySelector('#link-github');
      return {
        href: link?.getAttribute('href') ?? null,
        target: link?.getAttribute('target') ?? null,
        rel: link?.getAttribute('rel') ?? null,
        title: link?.getAttribute('title') ?? null,
        inTips: [...document.querySelectorAll('.empty-tips a')].some((a) => a.href.includes('github.com')),
      };
    `);
    check(
      '顶栏有 GitHub 源码入口，指向仓库且新窗口打开',
      opensource.href === 'https://github.com/zzsqwq/OttaiCGM-Visualizer-Web' &&
        opensource.target === '_blank' &&
        (opensource.rel ?? '').includes('noopener'),
      JSON.stringify(opensource),
    );
    check('引导页也标明开源与许可', opensource.inTips && (opensource.title ?? '').includes('Apache-2.0'), String(opensource.title));

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

    // 再点一次「试试示例」不应该重复添加
    const sourcesBefore = await cdp.eval(`return document.querySelectorAll('#sources .source-item').length;`);
    await cdp.eval(`document.querySelector('#btn-sample').click(); return true;`);
    await sleep(900);
    const afterSecondClick = await cdp.eval(`
      return {
        days: document.querySelectorAll('#day-list .day-item').length,
        sources: document.querySelectorAll('#sources .source-item').length,
        removeBtnVisible: !document.querySelector('#btn-sample-remove').hidden,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
      };
    `);
    check(
      '重复点示例不会重复添加',
      afterSecondClick.days === 15 && afterSecondClick.sources === sourcesBefore,
      `${afterSecondClick.days} 天 / ${afterSecondClick.sources} 个来源（原 ${sourcesBefore}）`,
    );
    check('示例存在时显示「移除示例」入口', afterSecondClick.removeBtnVisible);
    check(
      '重复点击有明确提示',
      afterSecondClick.toasts.some((t) => t.includes('已经在里面')),
      afterSecondClick.toasts.join(' | '),
    );

    // 手动「移除示例」按钮
    await cdp.eval(`document.querySelector('#btn-sample-remove').click(); return true;`);
    await cdp.waitFor(`!document.querySelector('#empty-state').hidden`, { label: '手动移除示例后回到引导页' });
    const afterManualRemove = await cdp.eval(`return { days: document.querySelectorAll('#day-list .day-item').length };`);
    check('「移除示例」可以一键清掉示例数据', afterManualRemove.days === 0, `剩余 ${afterManualRemove.days} 天`);
    // 再载入一次示例，继续验证「导入自己的数据后自动退场」
    await cdp.eval(`document.querySelector('#btn-sample-2').click(); return true;`);
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 15`, { label: '再次载入示例' });
    await sleep(500);

    // 导入自己的数据后，示例应当自动退场
    await cdp.setFileInput('#file-input', [FIXTURES.real]);
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 1`, { label: '导入自己的数据后只剩 1 天' });
    await sleep(600);
    const afterOwnImport = await cdp.eval(`
      const sources = [...document.querySelectorAll('#sources .source-item')].map(e => e.textContent);
      return {
        days: [...document.querySelectorAll('#day-list .day-item')].map(e => e.dataset.day),
        sources,
        removeBtnHidden: document.querySelector('#btn-sample-remove').hidden,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
      };
    `);
    check(
      '导入自己的数据后示例自动移除',
      afterOwnImport.days.length === 1 && afterOwnImport.days[0] === '2026-10-07' && afterOwnImport.sources.length === 1,
      `${afterOwnImport.days.join(',')} / ${afterOwnImport.sources.join(' · ')}`,
    );
    check('示例没了以后「移除示例」入口隐藏', afterOwnImport.removeBtnHidden);
    check(
      '自动移除有提示',
      afterOwnImport.toasts.some((t) => t.includes('已自动移除示例数据')),
      afterOwnImport.toasts.join(' | '),
    );
    // 已有自己的数据时，再点示例应该被拒绝（不掺杂）
    await cdp.eval(`document.querySelector('#btn-sample').click(); return true;`);
    await sleep(800);
    const refuse = await cdp.eval(`
      return {
        days: document.querySelectorAll('#day-list .day-item').length,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
      };
    `);
    check(
      '已有自己的数据时不再叠加示例',
      refuse.days === 1 && refuse.toasts.some((t) => t.includes('示例就不叠加了')),
      `${refuse.days} 天 · ${refuse.toasts.join(' | ')}`,
    );
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
    await cdp.eval(`
      window.__ottai.app.chart.chart.dispatchAction({ type: 'dataZoom', startValue: 730, endValue: 990 });
      return true;
    `);
    await sleep(500);
    const zoomed = await cdp.eval(`
      const app = window.__ottai.app;
      const day = document.querySelector('.day-item.is-active').dataset.day;
      const expected = app.debugAnnotations().filter(a => a.day === day && a.min >= 730 && a.min <= 990).map(a => a.id).sort();
      const visible = selector => [...document.querySelectorAll(selector)].filter(e => getComputedStyle(e).display !== 'none');
      return {
        expected,
        labels: visible('.ann-label').map(e => e.dataset.id).sort(),
        anchors: visible('.ann-anchor').map(e => e.dataset.id).sort(),
        paths: visible('.ann-path').length,
        exported: app.overlay.snapshotLayout().map(a => a.id).sort(),
        total: app.debugAnnotations().filter(a => a.day === day).length,
      };
    `);
    const sameIds = ids => JSON.stringify(ids) === JSON.stringify(zoomed.expected);
    check('缩放后只显示当前时段的标签、锚点和引线',
      zoomed.expected.length > 0 && zoomed.total > zoomed.expected.length && sameIds(zoomed.labels) && sameIds(zoomed.anchors) && zoomed.paths === zoomed.expected.length);
    check('缩放后的导出布局只包含可见标注', sameIds(zoomed.exported));
    await cdp.eval(`document.querySelector('#btn-reset-zoom').click(); return true;`);
    await sleep(500);
    const resetLabels = await cdp.eval(`return [...document.querySelectorAll('.ann-label')].filter(e => getComputedStyle(e).display !== 'none').length;`);
    check('重置缩放后恢复全天标注', resetLabels === zoomed.total, String(resetLabels));

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

    // ---------------------------------------------------------- 旧数据迁移与来源管理
    console.log('\n[11] 旧版本数据迁移 + 移除单个来源');

    // 先清空（同时清掉本地存储），否则注入的旧数据会在刷新时被自动保存覆盖
    await cdp.eval(`
      window.confirm = () => true;
      document.querySelector('#btn-export').click();
      return true;
    `);
    await sleep(200);
    await cdp.eval(`document.querySelector('#export-menu [data-act="clear"]').click(); return true;`);
    await cdp.waitFor(`!document.querySelector('#empty-state').hidden`, { label: '清空后回到引导页' });

    await cdp.eval(`
      // 模拟旧版本存下来的数据：示例来源没有标记、还有一条日期已经不存在了的标注
      const legacy = {
        v: 1,
        savedAt: Date.now(),
        readings: { '2025-03-16': [0, 5.6, 5, 5.7], '2025-03-17': [0, 6.2], '2026-10-07': [0, 6.1, 5, 6.3] },
        annotations: [{ day: '2024-01-01', min: 600, text: '日期已经没有数据的旧标注', offset: 1 }],
        sources: [
          { name: 'OttaiCGM-示例数据.xlsx', readings: 3, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
          { name: 'OttaiCGM_E40A758F7AC3.xlsx', readings: 2, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose', days: ['2026-10-07'] },
        ],
      };
      localStorage.setItem('ottai-cgm:workspace:v1', JSON.stringify(legacy));
      return true;
    `);
    await cdp.send('Page.reload');
    await cdp.waitFor(`document.documentElement.dataset.appReady === '1'`, { label: '迁移后启动' });
    await sleep(900);
    const migrated = await cdp.eval(`
      return {
        removeBtnVisible: !document.querySelector('#btn-sample-remove').hidden,
        days: document.querySelectorAll('#day-list .day-item').length,
        orphanHint: document.querySelector('#sources .source-hint')?.textContent.trim() ?? null,
      };
    `);
    check('旧数据能按文件名识别出示例来源', migrated.removeBtnVisible && migrated.days === 3, JSON.stringify(migrated));
    check('孤立标注有提示', Boolean(migrated.orphanHint && migrated.orphanHint.includes('已移除的日期')), String(migrated.orphanHint));

    // 一键清理孤立标注
    await cdp.eval(`document.querySelector('#sources .source-hint button').click(); return true;`);
    await sleep(600);
    const afterOrphanClean = await cdp.eval(`
      return {
        hint: document.querySelector('#sources .source-hint')?.textContent.trim() ?? null,
        annotations: window.__ottai.app.debugAnnotations().length,
      };
    `);
    check('可以一键清理孤立标注', afterOrphanClean.hint === null && afterOrphanClean.annotations === 0, JSON.stringify(afterOrphanClean));

    // 移除示例
    await cdp.eval(`document.querySelector('#btn-sample-remove').click(); return true;`);
    await sleep(700);
    const afterMigratedRemove = await cdp.eval(`
      return {
        days: [...document.querySelectorAll('#day-list .day-item')].map(e => e.dataset.day),
        sources: [...document.querySelectorAll('#sources .source-item')].map(e => e.textContent.trim()),
      };
    `);
    check(
      '迁移后一键移除示例，只留自己的数据',
      afterMigratedRemove.days.length === 1 && afterMigratedRemove.days[0] === '2026-10-07' && afterMigratedRemove.sources.length === 1,
      `${afterMigratedRemove.days.join(',')} / ${afterMigratedRemove.sources.join(' · ')}`,
    );

    // ---- 移除单个来源 ----
    await cdp.setFileInput('#file-input', [FIXTURES.big]);
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 16`, { label: '追加导入后 16 天' });
    await sleep(600);
    const beforeRemove = await cdp.eval(`
      return {
        sources: document.querySelectorAll('#sources .source-item').length,
        rows: [...document.querySelectorAll('#sources .source-item')].map(e => e.querySelector('.source-name').textContent),
      };
    `);
    check('两个来源都列出来了', beforeRemove.sources === 2, beforeRemove.rows.join(' · '));

    // 点第二个来源的删除按钮（OttaiCGM_20250330.xlsx）
    await cdp.eval(`
      const rows = [...document.querySelectorAll('#sources .source-item')];
      const row = rows.find(r => r.querySelector('.source-name').textContent.includes('20250330'));
      row.querySelector('.source-del').click();
      return true;
    `);
    await cdp.waitFor(`document.querySelectorAll('#day-list .day-item').length === 1`, { label: '移除来源后只剩 1 天' });
    await sleep(500);
    const afterSourceRemove = await cdp.eval(`
      return {
        days: [...document.querySelectorAll('#day-list .day-item')].map(e => e.dataset.day),
        sources: [...document.querySelectorAll('#sources .source-item')].map(e => e.querySelector('.source-name').textContent),
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
      };
    `);
    check(
      '可以移除单个来源，只删它带来的日期',
      afterSourceRemove.days.length === 1 && afterSourceRemove.days[0] === '2026-10-07' && afterSourceRemove.sources.length === 1,
      `${afterSourceRemove.days.join(',')} / ${afterSourceRemove.sources.join(' · ')}`,
    );
    check(
      '移除来源有明确提示',
      afterSourceRemove.toasts.some((t) => t.includes('已移除')),
      afterSourceRemove.toasts.slice(-1).join(''),
    );

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
