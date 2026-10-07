/**
 * 应用装配层：把 store / 图表 / 叠加层 / 各种面板连起来
 */
import { store, type Settings } from '../state/store';
import type { Annotation, Peak, Reading, SourceInfo } from '../core/types';
import { parseFile, type ParseOutcome, type ParsedAnnotationDraft } from '../core/parser';
import { findDailyPeaks } from '../core/peaks';
import { computeStats } from '../core/stats';
import { formatDayCn, formatDayShortCn, formatHM, parseClock, weekdayCn } from '../core/time';
import { valueAt } from '../core/series';
import { paletteFor, type Palette } from '../chart/theme';
import { DayChart } from '../chart/dayChart';
import { AnnotationOverlay } from '../chart/overlay';
import * as storage from '../state/storage';
import {
  annotationsToCsv,
  composePng,
  csvRowsForReadings,
  downloadBlob,
  downloadText,
  workspaceToJson,
} from '../io/exporters';
import { clear, h, qs } from './dom';

const SAMPLE_FILES = ['sample/OttaiCGM-示例数据.xlsx', 'sample/活动标注-示例.csv'];

export class App {
  private chart: DayChart | null = null;
  private overlay: AnnotationOverlay | null = null;
  private palette: Palette = paletteFor('light');
  private chartSig = '';
  private structuralSig = '';
  private peakCache = new Map<string, Peak[]>();
  private dragDepth = 0;
  private ro: ResizeObserver | null = null;
  private renderQueued = false;
  private saveTimer = 0;
  private saveWarned = false;

  // DOM
  private $ = {
    empty: qs('#empty-state'),
    pendingAnn: qs('#pending-ann'),
    workspace: qs('#workspace'),
    fileInput: qs<HTMLInputElement>('#file-input'),
    dayList: qs('#day-list'),
    dayCount: qs('#day-count'),
    dayTitle: qs('#day-title'),
    daySub: qs('#day-sub'),
    stats: qs('#stats'),
    chartWrap: qs('#chart-wrap'),
    chartEl: qs('#chart'),
    leaders: qs<SVGSVGElement>('#leaders'),
    labels: qs('#labels'),
    addHint: qs('#add-hint'),
    readout: qs('#hover-readout'),
    annList: qs('#ann-list'),
    annEmpty: qs('#ann-empty'),
    annCount: qs('#ann-count'),
    sources: qs('#sources'),
    toasts: qs('#toast-host'),
    drop: qs('#drop-overlay'),
    chkPeaks: qs<HTMLInputElement>('#chk-peaks'),
    peakDistance: qs<HTMLInputElement>('#peak-distance'),
    peakProminence: qs<HTMLInputElement>('#peak-prominence'),
    targetLow: qs<HTMLInputElement>('#target-low'),
    targetHigh: qs<HTMLInputElement>('#target-high'),
    btnAdd: qs<HTMLButtonElement>('#btn-add'),
  };

  async start(): Promise<void> {
    const settings = storage.loadSettings();
    store.setSettings(settings);

    this.bindEvents();
    store.subscribe(() => {
      this.scheduleRender();
      this.scheduleSave();
    });
    window.addEventListener('beforeunload', () => this.flushSave());

    const saved = storage.loadWorkspace();
    if (saved && (saved.readings.length || saved.annotations.length)) {
      if (saved.readings.length) store.setDataset(saved.readings, saved.sources);
      if (saved.annotations.length) store.addAnnotations(saved.annotations);
      const days = store.days();
      // 回到上次看的那一天，没有记录就停在最新的一天
      const lastSeen = saved.currentDay && days.includes(saved.currentDay) ? saved.currentDay : days[days.length - 1];
      if (lastSeen) store.setDay(lastSeen);
      const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('zh-CN') : '';
      if (saved.annotationsOnly) {
        store.toast(
          `已恢复 ${saved.annotations.length} 条标注${when ? `（${when}）` : ''}；血糖数据太大没能存下，重新导入文件即可对上`,
          'warn',
          7000,
        );
      } else {
        store.toast(
          `已恢复上次的数据（${days.length} 天 / ${saved.readings.length} 个点 / ${saved.annotations.length} 条标注）${when ? ` · ${when}` : ''}`,
          'info',
          4200,
        );
      }
    }

    this.render();
    document.documentElement.dataset.appReady = '1';
  }

  // ------------------------------------------------------------ 事件绑定

  private bindEvents(): void {
    const openPicker = () => this.$['fileInput'].click();
    qs('#btn-import').addEventListener('click', openPicker);
    qs('#btn-import-2').addEventListener('click', openPicker);
    qs('#btn-add-file').addEventListener('click', openPicker);
    qs('#btn-ann-import').addEventListener('click', openPicker);
    qs('#btn-sample').addEventListener('click', () => void this.loadSample());
    qs('#btn-sample-2').addEventListener('click', () => void this.loadSample());

    this.$['fileInput'].addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      const files = Array.from(input.files ?? []);
      input.value = '';
      void this.handleFiles(files);
    });

    // 拖拽导入
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.dragDepth++;
      this.$['drop'].hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', () => {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.$['drop'].hidden = true;
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dragDepth = 0;
      this.$['drop'].hidden = true;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void this.handleFiles(files);
    });

    // 工具栏
    this.$['btnAdd'].addEventListener('click', () => this.toggleAddMode());
    qs('#btn-reset-zoom').addEventListener('click', () => this.chart?.resetZoom());
    qs('#btn-theme').addEventListener('click', () => {
      store.setSettings({ theme: store.get().settings.theme === 'dark' ? 'light' : 'dark' });
    });
    qs('#btn-ann-csv').addEventListener('click', () => this.exportCsvDay());
    qs('#btn-ann-clear').addEventListener('click', () => {
      const day = store.get().currentDay;
      if (!day) return;
      const n = store.clearDayAnnotations(day);
      if (n) store.toast(`已删除本日 ${n} 条标注`, 'success');
    });

    this.$['chkPeaks'].addEventListener('change', () => {
      store.setSettings({ showPeaks: this.$['chkPeaks'].checked });
    });
    this.$['peakDistance'].addEventListener('change', () => {
      store.setSettings({ peakDistance: Number(this.$['peakDistance'].value) || 30, showPeaks: true });
    });
    this.$['peakProminence'].addEventListener('change', () => {
      store.setSettings({ peakProminence: Number(this.$['peakProminence'].value) || 0.3, showPeaks: true });
    });
    this.$['targetLow'].addEventListener('change', () => {
      const low = Number(this.$['targetLow'].value);
      const high = store.get().settings.target.high;
      if (Number.isFinite(low) && low > 0 && low < high) store.setTarget({ low });
      else this.$['targetLow'].value = String(store.get().settings.target.low);
    });
    this.$['targetHigh'].addEventListener('change', () => {
      const high = Number(this.$['targetHigh'].value);
      const low = store.get().settings.target.low;
      if (Number.isFinite(high) && high > low) store.setTarget({ high });
      else this.$['targetHigh'].value = String(store.get().settings.target.high);
    });

    // 弹层
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const trigger = target.closest('[aria-haspopup="true"]') as HTMLElement | null;
      const openPanels = document.querySelectorAll<HTMLElement>('.popover:not([hidden])');
      if (trigger) {
        const panel = trigger.parentElement?.querySelector<HTMLElement>('.popover');
        openPanels.forEach((p) => {
          if (p !== panel) {
            p.hidden = true;
            p.parentElement?.querySelector('[aria-haspopup="true"]')?.setAttribute('aria-expanded', 'false');
          }
        });
        if (panel) {
          panel.hidden = !panel.hidden;
          trigger.setAttribute('aria-expanded', String(!panel.hidden));
        }
        return;
      }
      if (!target.closest('.popover')) {
        openPanels.forEach((p) => {
          p.hidden = true;
          p.parentElement?.querySelector('[aria-haspopup="true"]')?.setAttribute('aria-expanded', 'false');
        });
      }
    });

    qs('#export-menu').addEventListener('click', (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act) return;
      (ev.target as HTMLElement).closest<HTMLElement>('.popover')!.hidden = true;
      void this.handleExport(act);
    });

    // 键盘
    document.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else if (!store.undo()) store.toast('没有可撤销的操作', 'info', 1600);
        return;
      }
      if (typing) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === 'Escape') {
        if (store.get().addMode) this.toggleAddMode(false);
        else store.select(null);
      } else if (e.key === 'ArrowLeft') {
        store.stepDay(-1);
      } else if (e.key === 'ArrowRight') {
        store.stepDay(1);
      } else if (e.key.toLowerCase() === 'n') {
        this.toggleAddMode();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.get().selectedId) {
        e.preventDefault();
        store.removeAnnotation(store.get().selectedId!);
      }
    });
  }

  // ------------------------------------------------------------ 导入

  private async handleFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    const readings: Reading[] = [];
    const sources: SourceInfo[] = [];
    const drafts: ParsedAnnotationDraft[] = [];
    const warnings: string[] = [];
    const dayNames: string[] = [];
    let workspaceApplied = false;

    for (const file of files) {
      let outcome: ParseOutcome;
      try {
        outcome = await parseFile(file);
      } catch (err) {
        warnings.push(`「${file.name}」读取失败：${(err as Error).message}`);
        continue;
      }
      warnings.push(...outcome.warnings);

      if (outcome.kind === 'workspace') {
        this.applyWorkspace(outcome);
        workspaceApplied = true;
        continue;
      }
      if (outcome.kind === 'unknown' || (outcome.readings.length === 0 && outcome.annotations.length === 0)) {
        warnings.push(`「${file.name}」里没找到血糖数据或标注，请检查文件格式`);
        continue;
      }
      if (outcome.readings.length) {
        readings.push(...outcome.readings);
        sources.push({ ...outcome.source, readings: outcome.readings.length });
        dayNames.push(...outcome.readings.map((r) => r.day));
      }
      if (outcome.annotations.length) {
        drafts.push(...outcome.annotations);
        const src = { ...outcome.source, kind: 'annotations' as const };
        if (!outcome.readings.length) sources.push(src);
      }
    }

    if (readings.length) {
      const { added, duplicates } = store.addReadings(readings, sources);
      const days = [...new Set(dayNames)].sort();
      this.peakCache.clear();
      const newest = days[days.length - 1];
      if (newest && store.days().includes(newest)) store.setDay(newest);
      store.toast(
        `已导入 ${days.length} 天 / ${added} 个血糖点${duplicates ? `（${duplicates} 个重复时间点已更新）` : ''}`,
        'success',
        4000,
      );
    }

    if (drafts.length) {
      const day = store.get().currentDay ?? store.days()[store.days().length - 1] ?? null;
      const withDay = drafts.filter((d) => d.day).length;
      if (day) {
        const n = store.addDrafts(drafts, day);
        store.toast(`已导入 ${n} 条活动标注${withDay < n ? `（其中 ${n - withDay} 条没有日期，归到 ${day}）` : ''}`, 'success', 4000);
      } else {
        warnings.push('标注文件里没有日期信息，也没有血糖数据可以对应，暂时无法导入');
      }
    }

    if (!readings.length && !drafts.length && !workspaceApplied) {
      store.toast('没有导入任何数据', 'warn');
    }
    for (const w of warnings.slice(0, 4)) store.toast(w, 'warn', 5200);
    if (warnings.length > 4) store.toast(`还有 ${warnings.length - 4} 条提示未显示`, 'warn');
  }

  private applyWorkspace(outcome: ParseOutcome): void {
    const readings = outcome.readings;
    const days = [...new Set(readings.map((r) => r.day))].sort();
    store.setDataset(readings, outcome.source.readings ? [{ ...outcome.source, kind: 'glucose' }] : []);
    const s = outcome.settings as Partial<Settings> | undefined;
    if (s) store.setSettings(s);
    if (outcome.annotations.length) {
      const fallback = days[days.length - 1] ?? '';
      store.addDrafts(outcome.annotations, fallback);
    }
    if (days.length) store.setDay(days[days.length - 1]);
    this.peakCache.clear();
    store.toast(`已从备份恢复：${days.length} 天 / ${readings.length} 个点 / ${outcome.annotations.length} 条标注`, 'success', 4000);
  }

  private async loadSample(): Promise<void> {
    try {
      store.toast('正在载入示例数据…', 'info', 2000);
      const files: File[] = [];
      for (const path of SAMPLE_FILES) {
        const res = await fetch(new URL(path, document.baseURI).href);
        if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
        const blob = await res.blob();
        files.push(new File([blob], path.split('/').pop() ?? path, { type: blob.type }));
      }
      await this.handleFiles(files);
    } catch (err) {
      store.toast(`示例数据加载失败：${(err as Error).message}（本地打开 index.html 时请改用「导入数据」）`, 'error', 6000);
    }
  }

  // ------------------------------------------------------------ 导出

  private async handleExport(act: string): Promise<void> {
    const state = store.get();
    const day = state.currentDay;
    switch (act) {
      case 'png':
        await this.exportPng();
        return;
      case 'csv-day':
        this.exportCsvDay();
        return;
      case 'csv-all': {
        const all = store.allAnnotations();
        if (!all.length) return store.toast('还没有任何标注', 'warn');
        downloadText('血糖活动标注-全部.csv', annotationsToCsv(all));
        store.toast(`已导出 ${all.length} 条标注`, 'success');
        return;
      }
      case 'csv-glucose': {
        if (!day) return;
        const readings = store.dayReadings(day);
        if (!readings.length) return store.toast('本日没有血糖数据', 'warn');
        downloadText(`血糖数据-${day.replace(/-/g, '')}.csv`, '\uFEFF' + csvRowsForReadings(readings));
        store.toast(`已导出本日 ${readings.length} 个血糖数据点`, 'success');
        return;
      }
      case 'json': {
        const json = workspaceToJson(state.dataset, state.annotations, state.settings as unknown as Record<string, unknown>);
        downloadText(`血糖可视化-备份-${day ?? 'empty'}.json`, json, 'application/json');
        store.toast('已导出完整备份，可随时用「从 JSON 恢复」载入', 'success');
        return;
      }
      case 'import-json':
        this.$['fileInput'].click();
        return;
      case 'clear': {
        if (!window.confirm('确定要清空本地保存的数据和标注吗？这一步不可撤销（建议先导出 JSON 备份）。')) return;
        storage.clearWorkspace();
        store.clearDataset();
        this.chartSig = '';
        this.structuralSig = '';
        this.saveWarned = false;
        store.toast('已清空本地数据', 'success');
        return;
      }
      default:
        return;
    }
  }

  private exportCsvDay(): void {
    const day = store.get().currentDay;
    if (!day) return;
    const anns = store.annotationsForDay(day);
    if (!anns.length) return store.toast('本日还没有标注', 'warn');
    downloadText(`annotations-${day.replace(/-/g, '')}.csv`, annotationsToCsv(anns));
    store.toast(`已导出本日 ${anns.length} 条标注`, 'success');
  }

  /** 合成「图表 + 标注 + 标题」的 PNG */
  private async buildPngBlob(): Promise<{ blob: Blob; day: string } | null> {
    const chart = this.chart;
    const overlay = this.overlay;
    const state = store.get();
    const day = state.currentDay;
    if (!chart || !overlay || !day) return null;
    const readings = store.dayReadings(day);
    const stats = computeStats(readings, state.settings.target);
    const blob = await composePng({
      chartDataUrl: await chart.captureForExport(2, this.palette.cardBg),
      pixelRatio: 2,
      palette: this.palette,
      day,
      stats,
      labels: overlay.snapshotLayout(),
      annotationCount: store.annotationsForDay(day).length,
    });
    return { blob, day };
  }

  private async exportPng(): Promise<void> {
    try {
      const result = await this.buildPngBlob();
      if (!result) return;
      downloadBlob(`血糖曲线_${formatDayCn(result.day)}.png`, result.blob);
      store.toast('图片已导出（含标注）', 'success');
    } catch (err) {
      store.toast(`导出图片失败：${(err as Error).message}`, 'error');
    }
  }

  // ------------------------------------------------------------ 调试入口（控制台 / 自动化测试用）

  debugAnnotations(): Annotation[] {
    return store.get().annotations;
  }

  debugPeaks(): Peak[] {
    const day = store.get().currentDay;
    return day ? this.peaksForDay(day) : [];
  }

  async debugExportPng(): Promise<Blob | null> {
    return (await this.buildPngBlob())?.blob ?? null;
  }

  // ------------------------------------------------------------ 标注交互

  private toggleAddMode(force?: boolean): void {
    const on = force ?? !store.get().addMode;
    if (on && !store.get().currentDay) {
      store.toast('先导入数据再加标注', 'warn');
      return;
    }
    store.setAddMode(on);
    if (on) store.toast('点击曲线上任意位置添加标注（按 Esc 退出）', 'info', 2600);
  }

  private addAnnotationAt(min: number): void {
    const state = store.get();
    const day = state.currentDay;
    if (!day) return;
    const readings = store.dayReadings(day);
    const snapped = this.snapToReading(readings, min);
    const created = store.addAnnotation({ day, min: snapped, text: '', offset: 1.5 });
    this.toggleAddMode(false);
    // 等 DOM 渲染出来再进入编辑
    requestAnimationFrame(() => this.overlay?.startEditing(created.id));
  }

  private snapToReading(readings: Reading[], min: number): number {
    if (!readings.length) return Math.round(min);
    let best = readings[0].min;
    let bestDist = Math.abs(best - min);
    for (const r of readings) {
      const d = Math.abs(r.min - min);
      if (d < bestDist) {
        bestDist = d;
        best = r.min;
      }
    }
    return bestDist <= 8 ? best : Math.round(min);
  }

  // ------------------------------------------------------------ 渲染

  // ------------------------------------------------------------ 本地保存

  /** 防抖保存：数据只在浏览器里，刷新后自动恢复 */
  private scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 500);
  }

  private saveNow(): boolean {
    const state = store.get();
    storage.saveSettings(state.settings);
    if (!state.dataset && state.annotations.length === 0) return true;
    const result = storage.saveWorkspace(
      state.dataset?.readings ?? [],
      state.annotations,
      state.dataset?.sources ?? [],
      state.currentDay,
    );
    if (result.degraded && !this.saveWarned) {
      this.saveWarned = true;
      store.toast(
        '血糖数据超出浏览器本地存储上限，已改为只保存标注；建议用「导出 → 备份全部数据 (JSON)」保存完整数据',
        'warn',
        8000,
      );
    } else if (!result.ok && !this.saveWarned) {
      this.saveWarned = true;
      store.toast('本地保存失败（可能是浏览器存储被禁用或已满），请用「导出 → 备份全部数据」留存', 'warn', 8000);
    }
    return result.ok;
  }

  private flushSave(): void {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = 0;
    }
    this.saveNow();
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const state = store.get();
    const hasData = !!state.dataset && state.dataset.days.length > 0;

    this.palette = paletteFor(state.settings.theme);
    document.documentElement.dataset.theme = state.settings.theme;

    this.$['empty'].hidden = hasData;
    this.$['workspace'].hidden = !hasData;
    this.renderToasts();

    // 血糖数据没存下、但标注还在的情况：提示用户重新导入文件
    const pending = this.$['pendingAnn'];
    const orphan = !hasData && state.annotations.length > 0;
    pending.hidden = !orphan;
    if (orphan) {
      pending.textContent = `本地还保存着 ${state.annotations.length} 条标注，导入对应的血糖文件后就会自动出现在图上。`;
    }

    if (!hasData) return;

    this.renderDayList();
    this.renderHeader();
    this.renderStats();
    this.renderChart();
    this.renderAnnotations();
    this.renderSources();
    this.renderToolbarState();
  }

  private renderToasts(): void {
    const state = store.get();
    clear(this.$['toasts']);
    for (const t of state.toasts) {
      this.$['toasts'].appendChild(h('div', { class: `toast ${t.kind}`, text: t.text }));
    }
  }

  private renderDayList(): void {
    const state = store.get();
    const days = [...store.days()].reverse();
    clear(this.$['dayList']);
    this.$['dayCount'].textContent = `${days.length} 天`;

    for (const day of days) {
      const stats = store.statsFor(day);
      const bar = h('div', { class: 'mini-bar' }, [
        h('i', { class: 'seg low', style: `width:${stats.tbr}%` }),
        h('i', { class: 'seg in', style: `width:${stats.tir}%` }),
        h('i', { class: 'seg high', style: `width:${stats.tar}%` }),
      ]);
      const item = h(
        'li',
        {
          class: `day-item${day === state.currentDay ? ' is-active' : ''}`,
          dataset: { day },
          title: `${formatDayCn(day)} · 平均 ${stats.mean.toFixed(1)} mmol/L · TIR ${stats.tir.toFixed(0)}%`,
        },
        [
          h('div', { class: 'day-item-top' }, [
            h('span', { class: 'day-item-date', text: formatDayShortCn(day) }),
            h('span', { class: 'day-item-wd', text: weekdayCn(day) }),
          ]),
          bar,
          h('div', { class: 'day-item-meta' }, [
            h('span', { text: `平均 ${stats.mean.toFixed(1)}` }),
            h('span', { class: 'dot-sep', text: '·' }),
            h('span', { text: `TIR ${stats.tir.toFixed(0)}%` }),
          ]),
        ],
      );
      item.addEventListener('click', () => store.setDay(day));
      this.$['dayList'].appendChild(item);
    }
  }

  private renderHeader(): void {
    const day = store.get().currentDay;
    if (!day) return;
    const readings = store.dayReadings(day);
    this.$['dayTitle'].textContent = `${formatDayCn(day)} ${weekdayCn(day)}`;
    const first = readings[0];
    const last = readings[readings.length - 1];
    const span = first && last ? `${formatHM(first.min)} – ${formatHM(last.min)}` : '';
    this.$['daySub'].textContent = `${readings.length} 个数据点${span ? ` · ${span}` : ''}`;
  }

  private renderStats(): void {
    const state = store.get();
    const day = state.currentDay!;
    const readings = store.dayReadings(day);
    const stats = computeStats(readings, state.settings.target);
    clear(this.$['stats']);

    const chip = (label: string, value: string, unit = '', tone = '') =>
      h('div', { class: `stat ${tone}` }, [
        h('span', { class: 'stat-label', text: label }),
        h('span', { class: 'stat-value' }, [value, unit ? h('i', { text: unit }) : null]),
      ]);

    this.$['stats'].appendChild(
      h('div', { class: 'stat-row' }, [
        chip('平均', stats.mean.toFixed(1), 'mmol/L'),
        chip('最高', stats.max.toFixed(1), 'mmol/L', 'high'),
        chip('最低', stats.min.toFixed(1), 'mmol/L', 'low'),
        chip('CV', stats.cv.toFixed(0), '%'),
        chip('GMI', stats.gmi.toFixed(1), '%'),
        chip('数据完整度', (stats.coverage * 100).toFixed(0), '%'),
      ]),
    );

    const track = h('div', { class: 'tir-track' }, [
      h('i', { class: 'seg low', style: `width:${stats.tbr}%` }),
      h('i', { class: 'seg in', style: `width:${stats.tir}%` }),
      h('i', { class: 'seg high', style: `width:${stats.tar}%` }),
    ]);
    this.$['stats'].appendChild(
      h('div', { class: 'tir' }, [
        h('div', { class: 'tir-label' }, [
          h('strong', { text: `TIR ${stats.tir.toFixed(0)}%` }),
          h('span', {
            class: 'muted',
            text: `目标范围 ${state.settings.target.low}–${state.settings.target.high} mmol/L`,
          }),
        ]),
        track,
        h('div', { class: 'tir-legend' }, [
          h('span', {}, [h('i', { class: 'dot low' }), `偏低 ${stats.tbr.toFixed(0)}%`]),
          h('span', {}, [h('i', { class: 'dot in' }), `目标内 ${stats.tir.toFixed(0)}%`]),
          h('span', {}, [h('i', { class: 'dot high' }), `偏高 ${stats.tar.toFixed(0)}%`]),
        ]),
      ]),
    );
  }

  private peaksForDay(day: string): Peak[] {
    const state = store.get();
    if (!state.settings.showPeaks) return [];
    const readings = state.dayIndex.get(day) ?? [];
    if (readings.length < 5) return [];
    const key = `${day}|${state.settings.peakDistance}|${state.settings.peakProminence}|${readings.length}|${readings[0].v}`;
    const cached = this.peakCache.get(key);
    if (cached) return cached;
    const steps: number[] = [];
    for (let i = 1; i < Math.min(readings.length, 40); i++) steps.push(readings[i].min - readings[i - 1].min);
    steps.sort((a, b) => a - b);
    const step = steps.length ? steps[steps.length >> 1] || 5 : 5;
    const peaks = findDailyPeaks(
      readings.map((r) => r.v),
      {
        minDistanceMinutes: state.settings.peakDistance,
        prominence: state.settings.peakProminence,
        stepMinutes: step,
        minValue: state.settings.target.high,
      },
    ).map((p) => ({ day, min: readings[p.index].min, v: readings[p.index].v }));
    this.peakCache.set(key, peaks);
    return peaks;
  }

  private renderChart(): void {
    const state = store.get();
    const day = state.currentDay;
    if (!day) return;
    if (!this.chart) {
      this.chart = new DayChart(this.$['chartEl']);
      this.overlay = new AnnotationOverlay(
        this.$['chartWrap'],
        this.$['leaders'],
        this.$['labels'],
        this.chart,
        {
          onSelect: (id) => store.select(id),
          onCommit: (id, patch) => {
            const ann = store.get().annotations.find((a) => a.id === id);
            if (ann && patch.text !== undefined && !patch.text.trim()) {
              store.removeAnnotation(id);
              store.toast('没有填写内容，标注已取消', 'info', 2200);
              return;
            }
            store.updateAnnotation(id, patch);
          },
          onDelete: (id) => store.removeAnnotation(id),
          onEditStart: (id) => {
            this.$['annList'].querySelectorAll('.ann-item').forEach((el) => {
              el.classList.toggle('is-editing', (el as HTMLElement).dataset.id === id);
            });
          },
        },
      );
      this.bindChartEvents();
      this.ro = new ResizeObserver(() => {
        this.chart?.resize();
        this.overlay?.position();
      });
      this.ro.observe(this.$['chartWrap']);
    }

    const readings = store.dayReadings(day);
    const annotations = store.annotationsForDay(day);
    const peaks = this.peaksForDay(day);
    // 结构性变化（换天/换数据/改目标范围/切主题）才重置缩放；
    // 只是改标注时保留用户当前的缩放窗口
    const structural = [
      day,
      readings.length,
      readings[0]?.v ?? 0,
      state.settings.target.low,
      state.settings.target.high,
      state.settings.showPeaks ? 1 : 0,
      state.settings.peakDistance,
      state.settings.peakProminence,
      state.settings.theme,
    ].join('|');
    const sig = `${structural}|${annotations.map((a) => `${a.id}:${a.min}:${a.offset}`).join(',')}`;

    if (sig !== this.chartSig) {
      const keepZoom = this.structuralSig === structural;
      this.chart.setOption(
        {
          day,
          readings,
          annotations,
          peaks,
          target: state.settings.target,
          palette: this.palette,
        },
        keepZoom,
      );
      this.chartSig = sig;
      this.structuralSig = structural;
    }
    this.overlay?.setData(annotations, readings, state.selectedId);
  }

  private bindChartEvents(): void {
    const chart = this.chart;
    if (!chart) return;
    const zr = chart.chart.getZr();

    zr.on('click', (e: { offsetX: number; offsetY: number; target?: unknown }) => {
      if (!store.get().addMode) return;
      const min = chart.pixelToMin(e.offsetX);
      if (!Number.isFinite(min)) return;
      this.addAnnotationAt(Math.max(0, Math.min(1440, min)));
    });

    let raf = 0;
    zr.on('mousemove', (e: { offsetX: number }) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const day = store.get().currentDay;
        if (!day) return;
        const min = chart.pixelToMin(e.offsetX);
        if (!Number.isFinite(min) || min < 0 || min > 1440) {
          this.$['readout'].textContent = '';
          return;
        }
        const v = valueAt(store.dayReadings(day), min);
        this.$['readout'].textContent = v == null ? formatHM(min) : `${formatHM(min)} · ${v.toFixed(1)} mmol/L`;
      });
    });

    chart.chart.on('rendered', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.overlay?.position();
      });
    });

    this.$['chartEl'].addEventListener('mouseleave', () => {
      this.$['readout'].textContent = '';
    });
  }

  private renderAnnotations(): void {
    const state = store.get();
    const day = state.currentDay!;
    const annotations = store.annotationsForDay(day);
    this.overlay?.setData(annotations, store.dayReadings(day), state.selectedId);

    this.$['annCount'].textContent = annotations.length ? `${annotations.length} 条` : '';
    this.$['annEmpty'].hidden = annotations.length > 0;
    clear(this.$['annList']);

    for (const ann of annotations) {
      const timeInput = h('input', {
        class: 'ann-item-time',
        type: 'time',
        attrs: { step: '300', value: formatHM(ann.min), 'aria-label': '标注时间' },
      }) as HTMLInputElement;
      timeInput.addEventListener('change', () => {
        const min = parseClock(timeInput.value);
        if (min == null) {
          timeInput.value = formatHM(ann.min);
          return;
        }
        store.updateAnnotation(ann.id, { min });
      });
      timeInput.addEventListener('click', (e) => e.stopPropagation());

      const text = h('span', {
        class: 'ann-item-text',
        text: ann.text || '（点击填写内容）',
        title: '点击修改；图上也可以直接双击标签',
      });

      const item = h('li', { class: `ann-item${ann.id === state.selectedId ? ' is-selected' : ''}`, dataset: { id: ann.id } }, [
        timeInput,
        text,
        h('button', {
          class: 'ann-item-del',
          type: 'button',
          text: '×',
          title: '删除',
          on: {
            click: (e) => {
              e.stopPropagation();
              store.removeAnnotation(ann.id);
            },
          },
        }),
      ]);

      item.addEventListener('click', () => store.select(ann.id));
      text.addEventListener('click', (e) => {
        e.stopPropagation();
        this.beginListEdit(item, text, ann);
      });
      this.$['annList'].appendChild(item);
    }
  }

  private beginListEdit(item: HTMLElement, textEl: HTMLElement, ann: Annotation): void {
    if (item.classList.contains('is-editing')) return;
    item.classList.add('is-editing');
    const input = h('input', {
      class: 'ann-item-input',
      attrs: { value: ann.text, placeholder: '吃了什么 / 做了什么 / 感受' },
    }) as HTMLInputElement;
    input.value = ann.text;
    textEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      const span = h('span', { class: 'ann-item-text', text: value || ann.text || '（点击填写内容）' });
      input.replaceWith(span);
      item.classList.remove('is-editing');
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        this.beginListEdit(item, span, { ...ann, text: value });
      });
      if (commit && value !== ann.text) {
        if (!value) store.removeAnnotation(ann.id);
        else store.updateAnnotation(ann.id, { text: value });
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  private renderSources(): void {
    const state = store.get();
    clear(this.$['sources']);
    const sources = state.dataset?.sources ?? [];
    if (!sources.length) {
      this.$['sources'].appendChild(h('li', { class: 'muted small', text: '（本次会话未记录来源文件）' }));
      return;
    }
    for (const s of sources) {
      this.$['sources'].appendChild(
        h('li', { class: 'source-item' }, [
          h('span', { class: 'source-name', text: s.name, title: s.name }),
          h('span', { class: 'source-meta muted', text: s.kind === 'annotations' ? `${s.readings} 条标注` : `${s.readings} 点` }),
        ]),
      );
    }
  }

  private renderToolbarState(): void {
    const state = store.get();
    this.$['btnAdd'].classList.toggle('is-active', state.addMode);
    this.$['addHint'].hidden = !state.addMode;
    this.$['chartWrap'].classList.toggle('is-adding', state.addMode);
    this.$['chkPeaks'].checked = state.settings.showPeaks;
    this.$['peakDistance'].value = String(state.settings.peakDistance);
    this.$['peakProminence'].value = String(state.settings.peakProminence);
    this.$['targetLow'].value = String(state.settings.target.low);
    this.$['targetHigh'].value = String(state.settings.target.high);
  }
}
