/**
 * 本地持久化（localStorage）
 * 数据只存在浏览器里，刷新/关闭页面后自动恢复，不上传任何服务器。
 */
import type { Annotation, Reading, SourceInfo } from '../core/types';
import { DEFAULT_SETTINGS, type Settings } from './store';

const KEY_WORKSPACE = 'ottai-cgm:workspace:v1';
const KEY_SETTINGS = 'ottai-cgm:settings:v1';

interface StoredWorkspace {
  v: 1;
  savedAt: number;
  readings: Record<string, number[]>;
  annotations: Annotation[];
  sources: SourceInfo[];
  /** 上次看的是哪一天，重新打开时回到这里 */
  currentDay?: string | null;
}

export interface LoadedWorkspace {
  readings: Reading[];
  annotations: Annotation[];
  sources: SourceInfo[];
  savedAt: number;
  currentDay: string | null;
  /** true = 只存下了标注（血糖数据太大，超出浏览器配额） */
  annotationsOnly: boolean;
}

export interface SaveResult {
  /** 是否有内容被保存下来 */
  ok: boolean;
  /** true = 血糖数据没存下，只保住了标注 */
  degraded: boolean;
}

/**
 * 保存到 localStorage。
 * 血糖数据比标注大得多，万一超出浏览器配额（约 5MB），
 * 会退化成「只保存标注」——手写的东西绝对不能丢，数据文件可以重新导入。
 */
export function saveWorkspace(
  readings: Reading[],
  annotations: Annotation[],
  sources: SourceInfo[],
  currentDay: string | null,
): SaveResult {
  const grouped: Record<string, number[]> = {};
  for (const r of readings) {
    const arr = grouped[r.day] ?? (grouped[r.day] = []);
    arr.push(Math.round(r.min * 100) / 100, r.v);
  }
  const payload: StoredWorkspace = { v: 1, savedAt: Date.now(), readings: grouped, annotations, sources, currentDay };
  try {
    localStorage.setItem(KEY_WORKSPACE, JSON.stringify(payload));
    return { ok: true, degraded: false };
  } catch {
    /* 继续尝试只存标注 */
  }
  try {
    localStorage.removeItem(KEY_WORKSPACE);
    const lean: StoredWorkspace = {
      v: 1,
      savedAt: Date.now(),
      readings: {},
      annotations,
      sources: [],
      currentDay,
    };
    localStorage.setItem(KEY_WORKSPACE, JSON.stringify(lean));
    return { ok: true, degraded: true };
  } catch {
    return { ok: false, degraded: false };
  }
}

export function loadWorkspace(): LoadedWorkspace | null {
  try {
    const raw = localStorage.getItem(KEY_WORKSPACE);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredWorkspace;
    if (!data || data.v !== 1) return null;
    const readings: Reading[] = [];
    for (const [day, arr] of Object.entries(data.readings ?? {})) {
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const min = Number(arr[i]);
        const v = Number(arr[i + 1]);
        if (Number.isFinite(min) && Number.isFinite(v)) readings.push({ day, min, v });
      }
    }
    readings.sort((a, b) => (a.day === b.day ? a.min - b.min : a.day < b.day ? -1 : 1));
    const annotations = Array.isArray(data.annotations) ? data.annotations : [];
    return {
      readings,
      annotations,
      sources: Array.isArray(data.sources) ? data.sources : [],
      savedAt: data.savedAt ?? 0,
      currentDay: typeof data.currentDay === 'string' ? data.currentDay : null,
      annotationsOnly: readings.length === 0 && annotations.length > 0,
    };
  } catch {
    return null;
  }
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(KEY_WORKSPACE);
  } catch {
    /* 忽略 */
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  } catch {
    /* 忽略 */
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      target: { ...DEFAULT_SETTINGS.target, ...(parsed.target ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 首次访问时是否已经有数据 */
export function hasStoredWorkspace(): boolean {
  try {
    return localStorage.getItem(KEY_WORKSPACE) != null;
  } catch {
    return false;
  }
}
