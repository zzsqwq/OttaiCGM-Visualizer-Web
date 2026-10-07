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

  it('旧数据的示例来源没有 days 记录时，按「用户没覆盖的日期」兜底清理', () => {
    // 模拟迁移过来的旧数据：示例来源没有 days 字段
    store.setDataset(
      [reading('2025-03-16', 0), reading('2025-03-16', 5), reading('2026-10-07', 0)],
      [
        { name: 'OttaiCGM-示例数据.xlsx', readings: 2, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose', sample: true },
        userSource(['2026-10-07']),
      ],
    );
    const removed = store.removeSampleData();
    expect(removed.readings).toBe(2);
    expect(store.days()).toEqual(['2026-10-07']);
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

describe('单独移除某个来源', () => {
  it('移除来源会删掉它独占的日期，以及这些日期上的标注', () => {
    store.setDataset(
      [reading('2025-03-16', 0), reading('2025-03-16', 5), reading('2026-10-07', 0)],
      [userSource(['2025-03-16'], '旧数据.xlsx'), userSource(['2026-10-07'])],
    );
    store.addAnnotations([ann('2025-03-16', 600, '旧数据上的标注'), ann('2026-10-07', 700, '新数据上的标注')]);

    const plan = store.sourceRemovalPlan('旧数据.xlsx');
    expect(plan).toEqual({ name: '旧数据.xlsx', days: ['2025-03-16'], readings: 2, annotations: 1, importedAnnotations: 0 });

    const removed = store.removeSource('旧数据.xlsx');
    expect(removed).toEqual({ readings: 2, annotations: 1, days: ['2025-03-16'] });
    expect(store.days()).toEqual(['2026-10-07']);
    expect(store.get().annotations.map((a) => a.text)).toEqual(['新数据上的标注']);
    expect(store.get().dataset?.sources.map((s) => s.name)).toEqual(['我的数据.xlsx']);
  });

  it('日期被别的来源也覆盖时，数据与标注都保留（替换新版导出不会丢标注）', () => {
    store.setDataset(
      [reading('2026-10-07', 0), reading('2026-10-07', 5)],
      [userSource(['2026-10-07'], '旧导出.xlsx'), userSource(['2026-10-07'], '新导出.xlsx')],
    );
    store.addAnnotations([ann('2026-10-07', 700, '我自己写的')]);

    const plan = store.sourceRemovalPlan('旧导出.xlsx');
    expect(plan).toEqual({ name: '旧导出.xlsx', days: [], readings: 0, annotations: 0, importedAnnotations: 0 });

    const removed = store.removeSource('旧导出.xlsx');
    expect(removed.readings).toBe(0);
    expect(store.days()).toEqual(['2026-10-07']);
    expect(store.get().annotations.map((a) => a.text)).toEqual(['我自己写的']);
    expect(store.get().dataset?.sources.map((s) => s.name)).toEqual(['新导出.xlsx']);
  });

  it('移除标注文件时，精确删掉它带来的那些标注', () => {
    store.setDataset([reading('2026-10-07', 0)], [userSource(['2026-10-07'])]);
    store.addDrafts(
      [
        { day: '2026-10-07', min: 600, text: '来自标注文件', offset: 1 },
        { day: '2026-10-07', min: 700, text: '另一条', offset: -1 },
      ],
      '2026-10-07',
      { source: 'annotations-20261007.csv' },
    );
    store.addAnnotation({ day: '2026-10-07', min: 800, text: '我自己在图上写的', offset: 1 });

    const plan = store.sourceRemovalPlan('annotations-20261007.csv');
    expect(plan?.importedAnnotations).toBe(2);
    expect(plan?.readings).toBe(0); // 标注文件不带血糖点
    expect(plan?.days).toEqual([]); // 日期还在，所以没有日期会消失

    const removed = store.removeSource('annotations-20261007.csv');
    expect(removed.readings).toBe(0);
    expect(store.get().annotations.map((a) => a.text)).toEqual(['我自己在图上写的']);
    expect(store.days()).toEqual(['2026-10-07']);
  });

  it('移除旧格式来源（没有 days 记录）时按「别人没覆盖的日期」兜底', () => {
    store.setDataset(
      [reading('2025-03-16', 0), reading('2026-10-07', 0)],
      [
        { name: '老的.xlsx', readings: 1, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
        userSource(['2026-10-07']),
      ],
    );
    expect(store.sourceRemovalPlan('老的.xlsx')?.days).toEqual(['2025-03-16']);
    expect(store.removeSource('老的.xlsx').readings).toBe(1);
    expect(store.days()).toEqual(['2026-10-07']);
  });

  it('移除不存在的来源是空操作', () => {
    store.setDataset([reading('2026-10-07', 0)], [userSource(['2026-10-07'])]);
    expect(store.sourceRemovalPlan('没有这个文件.xlsx')).toBeNull();
    expect(store.removeSource('没有这个文件.xlsx')).toEqual({ readings: 0, annotations: 0, days: [] });
  });

  it('全部来源都移除后回到空状态', () => {
    store.setDataset([reading('2026-10-07', 0)], [userSource(['2026-10-07'])]);
    store.setDay('2026-10-07');
    store.removeSource('我的数据.xlsx');
    expect(store.days()).toEqual([]);
    expect(store.get().currentDay).toBeNull();
    expect(store.get().dataset?.sources).toEqual([]);
  });
});

describe('孤立标注（数据被移除后留下的）', () => {
  it('能识别并清理', () => {
    store.setDataset([reading('2026-10-07', 0)], [userSource(['2026-10-07'])]);
    store.addAnnotations([ann('2025-03-16', 600, '孤立的'), ann('2026-10-07', 700, '正常的')]);
    expect(store.orphanAnnotations().map((a) => a.text)).toEqual(['孤立的']);
    expect(store.removeOrphanAnnotations()).toBe(1);
    expect(store.get().annotations.map((a) => a.text)).toEqual(['正常的']);
  });

  it('没有数据时所有标注都算孤立（对应引导页的提示）', () => {
    store.addAnnotations([ann('2025-03-16', 600, '甲'), ann('2025-03-17', 600, '乙')]);
    expect(store.orphanAnnotations()).toHaveLength(2);
    expect(store.removeOrphanAnnotations()).toBe(2);
    expect(store.orphanAnnotations()).toEqual([]);
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
