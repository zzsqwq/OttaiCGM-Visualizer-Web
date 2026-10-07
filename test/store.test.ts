import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../src/state/store';
import type { Annotation, Reading, SourceInfo } from '../src/core/types';

const reading = (day: string, min: number, v = 6): Reading => ({ day, min, v });
const ann = (day: string, min: number, text: string, sample = false): Annotation => ({
  id: `${day}-${min}-${text}`,
  day,
  min,
  text,
  offset: 1,
  ...(sample ? { sample: true } : {}),
});
const sampleSource = (days: string[]): SourceInfo => ({
  name: 'OttaiCGM-示例数据.xlsx',
  readings: days.length * 288,
  skipped: 0,
  duplicates: 0,
  unit: 'mmol/L',
  kind: 'glucose',
  sample: true,
  days,
});
const userSource = (days: string[], name = '我的数据.xlsx'): SourceInfo => ({
  name,
  readings: days.length * 288,
  skipped: 0,
  duplicates: 0,
  unit: 'mmol/L',
  kind: 'glucose',
  days,
});

beforeEach(() => {
  store.clearDataset();
  store.setSettings({ target: { low: 3.9, high: 7.8 } });
});

describe('示例数据：识别与移除', () => {
  it('只有示例数据时：能识别、能整体移除', () => {
    store.setDataset([reading('2025-03-16', 0), reading('2025-03-16', 5), reading('2025-03-17', 0)], [sampleSource(['2025-03-16', '2025-03-17'])]);
    store.addAnnotations([ann('2025-03-16', 600, '示例标注', true)]);

    expect(store.hasSampleData()).toBe(true);
    expect(store.hasUserData()).toBe(false);

    const removed = store.removeSampleData();
    expect(removed).toEqual({ readings: 3, annotations: 1 });
    expect(store.days()).toEqual([]);
    expect(store.get().annotations).toEqual([]);
    expect(store.get().dataset?.sources).toEqual([]);
    expect(store.hasSampleData()).toBe(false);
  });

  it('移除示例时不动用户自己导入的数据和标注', () => {
    store.setDataset(
      [reading('2025-03-16', 0), reading('2026-10-07', 0), reading('2026-10-07', 5)],
      [sampleSource(['2025-03-16']), userSource(['2026-10-07'])],
    );
    store.addAnnotations([ann('2025-03-16', 600, '示例标注', true), ann('2026-10-07', 700, '我自己写的')]);

    const removed = store.removeSampleData();
    expect(removed.readings).toBe(1);
    expect(removed.annotations).toBe(1);
    expect(store.days()).toEqual(['2026-10-07']);
    expect(store.get().annotations.map((a) => a.text)).toEqual(['我自己写的']);
    expect(store.get().dataset?.sources.map((s) => s.name)).toEqual(['我的数据.xlsx']);
  });

  it('同一天用户自己也导入了数据时，不能把这一天的血糖删掉', () => {
    store.setDataset(
      [reading('2025-03-16', 0), reading('2025-03-16', 5), reading('2026-10-07', 0)],
      [sampleSource(['2025-03-16']), userSource(['2025-03-16', '2026-10-07'])],
    );
    const removed = store.removeSampleData();
    expect(removed.readings).toBe(0); // 2025-03-16 用户也有，保留
    expect(store.days()).toEqual(['2025-03-16', '2026-10-07']);
  });

  it('没有示例数据时移除是空操作', () => {
    store.setDataset([reading('2026-10-07', 0)], [userSource(['2026-10-07'])]);
    expect(store.removeSampleData()).toEqual({ readings: 0, annotations: 0 });
    expect(store.hasSampleData()).toBe(false);
    expect(store.days()).toEqual(['2026-10-07']);
  });

  it('只剩标注没有血糖时，照样能识别为示例并移除', () => {
    store.addAnnotations([ann('2025-03-16', 600, '示例标注', true)]);
    expect(store.hasSampleData()).toBe(true);
    expect(store.removeSampleData()).toEqual({ readings: 0, annotations: 1 });
  });
});

describe('来源列表', () => {
  it('同一个文件名重复导入只保留一条', () => {
    store.setDataset([reading('2026-10-07', 0)], [userSource(['2026-10-07']), userSource(['2026-10-07']), sampleSource(['2025-03-16'])]);
    expect(store.get().dataset?.sources.map((s) => s.name)).toEqual(['我的数据.xlsx', 'OttaiCGM-示例数据.xlsx']);
  });

  it('移除示例后当前日期会落到还剩下的那天', () => {
    store.setDataset([reading('2025-03-16', 0), reading('2026-10-07', 0)], [sampleSource(['2025-03-16']), userSource(['2026-10-07'])]);
    store.setDay('2025-03-16');
    store.removeSampleData();
    expect(store.get().currentDay).toBe('2026-10-07');
  });

  it('移除示例后没有数据了就把当前日期清空', () => {
    store.setDataset([reading('2025-03-16', 0)], [sampleSource(['2025-03-16'])]);
    store.setDay('2025-03-16');
    store.removeSampleData();
    expect(store.get().currentDay).toBeNull();
  });
});
