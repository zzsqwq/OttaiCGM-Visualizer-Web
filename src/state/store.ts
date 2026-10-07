/**
 * 应用状态（极简发布订阅，不引入框架）
 */
import type { Annotation, Dataset, Reading, TargetRange } from '../core/types';
import { DEFAULT_TARGET } from '../core/types';
import { mergeReadings, type ParsedAnnotationDraft } from '../core/parser';
import { computeStats, type Stats } from '../core/stats';
import { buildDayIndex, type DayIndex } from '../core/series';

export interface Settings {
  target: TargetRange;
  showPeaks: boolean;
  peakDistance: number;
  peakProminence: number;
  showAnnotationList: boolean;
  theme: 'light' | 'dark';
}

export const DEFAULT_SETTINGS: Settings = {
  target: { ...DEFAULT_TARGET },
  showPeaks: false,
  peakDistance: 30,
  peakProminence: 0.3,
  showAnnotationList: true,
  theme: 'light',
};

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface AppState {
  dataset: Dataset | null;
  dayIndex: DayIndex;
  annotations: Annotation[];
  currentDay: string | null;
  selectedId: string | null;
  settings: Settings;
  addMode: boolean;
  toasts: Toast[];
  busy: boolean;
}

type Listener = () => void;

let idSeq = 0;
export function makeId(prefix = 'a'): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`;
}

const HISTORY_LIMIT = 60;

class Store {
  private state: AppState = {
    dataset: null,
    dayIndex: new Map(),
    annotations: [],
    currentDay: null,
    selectedId: null,
    settings: { ...DEFAULT_SETTINGS },
    addMode: false,
    toasts: [],
    busy: false,
  };

  private listeners = new Set<Listener>();
  private statsCache = new Map<string, Stats>();
  private statsCacheKey = '';
  private past: Annotation[][] = [];
  private future: Annotation[][] = [];

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  // ---------------------------------------------------------------- 数据

  setDataset(readings: Reading[], sources: Dataset['sources']): void {
    const { readings: merged } = mergeReadings(readings, []);
    const days = [...new Set(merged.map((r) => r.day))].sort();
    const dataset: Dataset = {
      readings: merged,
      days,
      sources,
      convertedFromMgDl: sources.some((s) => s.unit === 'mg/dL'),
      loadedAt: Date.now(),
    };
    this.state = {
      ...this.state,
      dataset,
      dayIndex: buildDayIndex(merged),
      currentDay: this.state.currentDay && days.includes(this.state.currentDay) ? this.state.currentDay : (days[0] ?? null),
      selectedId: null,
    };
    this.emit();
  }

  /** 追加导入：同一天同一时刻以新数据为准 */
  addReadings(incoming: Reading[], sources: Dataset['sources']): { added: number; duplicates: number } {
    const base = this.state.dataset?.readings ?? [];
    const { readings, duplicates } = mergeReadings(incoming, base);
    const added = readings.length - base.length;
    const prevSources = this.state.dataset?.sources ?? [];
    this.setDataset(readings, [...prevSources, ...sources]);
    return { added, duplicates };
  }

  clearDataset(): void {
    this.state = {
      ...this.state,
      dataset: null,
      dayIndex: new Map(),
      annotations: [],
      currentDay: null,
      selectedId: null,
      addMode: false,
    };
    this.past = [];
    this.future = [];
    this.emit();
  }

  dayReadings(day = this.state.currentDay): Reading[] {
    if (!day) return [];
    return this.state.dayIndex.get(day) ?? [];
  }

  days(): string[] {
    return this.state.dataset?.days ?? [];
  }

  /**
   * 某一天的统计。
   *
   * 日期列表里每天都要算一次，而 render() 会在每次状态变化时被调用
   * （选标注、改设置、输文字……），数据量大时重复计算会明显卡顿，
   * 所以按「数据版本 + 目标范围 + 日期」缓存。
   */
  statsFor(day: string): Stats {
    const key = `${this.state.dataset?.loadedAt ?? 0}|${this.state.settings.target.low}|${this.state.settings.target.high}`;
    if (key !== this.statsCacheKey) {
      this.statsCache.clear();
      this.statsCacheKey = key;
    }
    const cached = this.statsCache.get(day);
    if (cached) return cached;
    const stats = computeStats(this.state.dayIndex.get(day) ?? [], this.state.settings.target);
    this.statsCache.set(day, stats);
    return stats;
  }

  // ---------------------------------------------------------------- 日期/选择

  setDay(day: string | null): void {
    this.set({ currentDay: day, selectedId: null, addMode: false });
  }

  stepDay(delta: number): void {
    const days = this.days();
    const cur = this.state.currentDay;
    if (!days.length || !cur) return;
    const idx = days.indexOf(cur);
    const next = days[Math.min(days.length - 1, Math.max(0, idx + delta))];
    if (next !== cur) this.setDay(next);
  }

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  // ---------------------------------------------------------------- 标注

  annotationsForDay(day = this.state.currentDay): Annotation[] {
    if (!day) return [];
    return this.state.annotations
      .filter((a) => a.day === day)
      .sort((a, b) => a.min - b.min);
  }

  allAnnotations(): Annotation[] {
    return [...this.state.annotations].sort((a, b) => (a.day === b.day ? a.min - b.min : a.day < b.day ? -1 : 1));
  }

  private pushHistory(): void {
    this.past.push(this.state.annotations.map((a) => ({ ...a })));
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  addAnnotation(ann: Omit<Annotation, 'id'>): Annotation {
    this.pushHistory();
    const created: Annotation = { ...ann, id: makeId() };
    this.state = { ...this.state, annotations: [...this.state.annotations, created], selectedId: created.id };
    this.emit();
    return created;
  }

  addAnnotations(list: (Omit<Annotation, 'id'> & { id?: string })[]): number {
    if (!list.length) return 0;
    this.pushHistory();
    const created = list.map((a) => ({ ...a, id: a.id ?? makeId() }));
    this.state = { ...this.state, annotations: [...this.state.annotations, ...created] };
    this.emit();
    return created.length;
  }

  /** 把「没有日期」的标注落到指定日期 */
  addDrafts(drafts: ParsedAnnotationDraft[], fallbackDay: string): number {
    return this.addAnnotations(
      drafts.map((d) => ({ day: d.day ?? fallbackDay, min: d.min, text: d.text, offset: d.offset })),
    );
  }

  updateAnnotation(id: string, patch: Partial<Omit<Annotation, 'id'>>, record = true): void {
    const idx = this.state.annotations.findIndex((a) => a.id === id);
    if (idx < 0) return;
    if (record) this.pushHistory();
    const next = [...this.state.annotations];
    next[idx] = { ...next[idx], ...patch };
    this.state = { ...this.state, annotations: next };
    this.emit();
  }

  /** 拖动结束后提交，把过程中的临时状态合并成一步撤销 */
  commitAnnotation(id: string, patch: Partial<Omit<Annotation, 'id'>>): void {
    this.updateAnnotation(id, patch, true);
  }

  removeAnnotation(id: string): void {
    const idx = this.state.annotations.findIndex((a) => a.id === id);
    if (idx < 0) return;
    this.pushHistory();
    this.state = {
      ...this.state,
      annotations: this.state.annotations.filter((a) => a.id !== id),
      selectedId: this.state.selectedId === id ? null : this.state.selectedId,
    };
    this.emit();
  }

  clearDayAnnotations(day: string): number {
    const removed = this.state.annotations.filter((a) => a.day === day).length;
    if (!removed) return 0;
    this.pushHistory();
    this.state = { ...this.state, annotations: this.state.annotations.filter((a) => a.day !== day), selectedId: null };
    this.emit();
    return removed;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.state.annotations.map((a) => ({ ...a })));
    this.state = { ...this.state, annotations: prev, selectedId: null };
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.state.annotations.map((a) => ({ ...a })));
    this.state = { ...this.state, annotations: next, selectedId: null };
    this.emit();
    return true;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  // ---------------------------------------------------------------- 设置

  setSettings(patch: Partial<Settings>): void {
    this.set({ settings: { ...this.state.settings, ...patch } });
  }

  setTarget(target: Partial<TargetRange>): void {
    this.setSettings({ target: { ...this.state.settings.target, ...target } });
  }

  setAddMode(on: boolean): void {
    this.set({ addMode: on });
  }

  // ---------------------------------------------------------------- 提示

  toast(text: string, kind: ToastKind = 'info', ms = 3200): void {
    const t: Toast = { id: ++idSeq, kind, text };
    this.set({ toasts: [...this.state.toasts, t] });
    window.setTimeout(() => {
      this.set({ toasts: this.state.toasts.filter((x) => x.id !== t.id) });
    }, ms);
  }
}

export const store = new Store();
export type { Annotation, Dataset };
