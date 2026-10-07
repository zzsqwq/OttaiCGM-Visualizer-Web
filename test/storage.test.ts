import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, Reading, SourceInfo } from '../src/core/types';

/** 最小的 localStorage 替身，可以模拟「超出配额」 */
class MemStorage {
  private map = new Map<string, string>();
  /** 单个 key 允许的最大字符数 */
  limit = Number.POSITIVE_INFINITY;

  get length(): number {
    return this.map.size;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    if (value.length > this.limit) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

let mem: MemStorage;

beforeEach(() => {
  mem = new MemStorage();
  vi.stubGlobal('localStorage', mem);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadStorage() {
  return await import('../src/state/storage');
}

const readings = (): Reading[] => [
  { day: '2025-03-27', min: 0, v: 5.6 },
  { day: '2025-03-27', min: 5, v: 5.8 },
  { day: '2025-03-30', min: 0, v: 6.1 },
];
const annotations = (): Annotation[] => [
  { id: 'a1', day: '2025-03-27', min: 730, text: '一杯拿铁', offset: 1.5 },
  { id: 'a2', day: '2025-03-30', min: 600, text: '早饭', offset: -1 },
];
const sources = (): SourceInfo[] => [
  { name: 'OttaiCGM_20250330.xlsx', readings: 3, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
];

describe('本地存储：关掉浏览器再打开能恢复', () => {
  it('保存后能原样读回来（数据 + 标注 + 上次看的日期）', async () => {
    const storage = await loadStorage();
    const result = storage.saveWorkspace(readings(), annotations(), sources(), '2025-03-27');
    expect(result).toEqual({ ok: true, degraded: false });

    const loaded = storage.loadWorkspace();
    expect(loaded).not.toBeNull();
    expect(loaded!.readings).toEqual(readings());
    expect(loaded!.annotations).toEqual(annotations());
    expect(loaded!.sources).toEqual(sources());
    expect(loaded!.currentDay).toBe('2025-03-27');
    expect(loaded!.annotationsOnly).toBe(false);
    expect(loaded!.savedAt).toBeGreaterThan(0);
  });

  it('再存一次会覆盖旧内容', async () => {
    const storage = await loadStorage();
    storage.saveWorkspace(readings(), annotations(), sources(), '2025-03-27');
    storage.saveWorkspace(readings(), [], [], '2025-03-30');
    const loaded = storage.loadWorkspace();
    expect(loaded!.annotations).toEqual([]);
    expect(loaded!.currentDay).toBe('2025-03-30');
  });

  it('没有存过东西时返回 null', async () => {
    const storage = await loadStorage();
    expect(storage.loadWorkspace()).toBeNull();
    expect(storage.hasStoredWorkspace()).toBe(false);
  });

  it('设置单独存一份，读回来会补齐默认值', async () => {
    const storage = await loadStorage();
    storage.saveSettings({
      target: { low: 4, high: 9 },
      showPeaks: true,
      peakDistance: 45,
      peakProminence: 0.5,
      showAnnotationList: true,
      theme: 'dark',
    });
    const settings = storage.loadSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.showPeaks).toBe(true);
    expect(settings.target).toEqual({ low: 4, high: 9 });
  });

  it('清空后读不到东西', async () => {
    const storage = await loadStorage();
    storage.saveWorkspace(readings(), annotations(), sources(), null);
    storage.clearWorkspace();
    expect(storage.loadWorkspace()).toBeNull();
  });
});

describe('本地存储：超出配额时的降级', () => {
  it('数据太大时改为只保存标注（标注绝不能丢）', async () => {
    const storage = await loadStorage();
    storage.saveSettings({} as never); // 先放一个无关的键，确认降级不会把它删掉
    const full = JSON.stringify({
      v: 1, savedAt: 0, readings: { '2025-03-27': [0, 5.6, 5, 5.8], '2025-03-30': [0, 6.1] },
      annotations: annotations(), sources: sources(), currentDay: '2025-03-27',
    });
    // 额度卡在「存得下标注、存不下完整数据」之间
    mem.limit = Math.max(200, full.length - 80);

    const result = storage.saveWorkspace(readings(), annotations(), sources(), '2025-03-27');
    expect(result).toEqual({ ok: true, degraded: true });

    const loaded = storage.loadWorkspace();
    expect(loaded!.annotations).toEqual(annotations());
    expect(loaded!.readings).toEqual([]);
    expect(loaded!.annotationsOnly).toBe(true);
    expect(loaded!.currentDay).toBe('2025-03-27');
  });

  it('连标注都存不下时如实返回失败', async () => {
    const storage = await loadStorage();
    mem.limit = 10;
    const result = storage.saveWorkspace(readings(), annotations(), sources(), null);
    expect(result).toEqual({ ok: false, degraded: false });
    expect(storage.loadWorkspace()).toBeNull();
  });

  it('配额恢复后能重新存下完整数据，并覆盖掉降级内容', async () => {
    const storage = await loadStorage();
    mem.limit = 300;
    const degraded = storage.saveWorkspace(readings(), annotations(), sources(), null);
    expect(degraded).toEqual({ ok: true, degraded: true });
    expect(storage.loadWorkspace()!.annotationsOnly).toBe(true);

    mem.limit = Number.POSITIVE_INFINITY;
    const result = storage.saveWorkspace(readings(), annotations(), sources(), '2025-03-30');
    expect(result).toEqual({ ok: true, degraded: false });
    expect(storage.loadWorkspace()!.annotationsOnly).toBe(false);
    expect(storage.loadWorkspace()!.readings).toHaveLength(3);
  });

  it('旧版本存的数据：按文件名把示例来源认出来（迁移）', async () => {
    const storage = await loadStorage();
    // 模拟旧版本存的来源（没有 sample 标记）
    const legacy = {
      v: 1,
      savedAt: Date.now(),
      readings: { '2025-03-16': [0, 5.6] },
      annotations: [],
      sources: [
        { name: 'OttaiCGM-示例数据.xlsx', readings: 1, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
        { name: '我的数据.xlsx', readings: 1, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
      ],
    };
    mem.setItem('ottai-cgm:workspace:v1', JSON.stringify(legacy));
    const loaded = storage.loadWorkspace();
    expect(loaded!.sources.map((s) => [s.name, Boolean(s.sample)])).toEqual([
      ['OttaiCGM-示例数据.xlsx', true],
      ['我的数据.xlsx', false],
    ]);
  });

  it('新版本自己存的示例标记不会被覆盖', async () => {
    const storage = await loadStorage();
    storage.saveWorkspace([], [], [{ name: '别的名字.xlsx', readings: 0, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose', sample: true }], null);
    const loaded = storage.loadWorkspace();
    expect(loaded!.sources[0].sample).toBe(true);
  });

  it('坏掉的 JSON 不会让应用崩溃', async () => {
    const storage = await loadStorage();
    mem.setItem('ottai-cgm:workspace:v1', '{ 这不是 json');
    expect(storage.loadWorkspace()).toBeNull();
  });
});
