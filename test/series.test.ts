import { describe, expect, it } from 'vitest';
import { buildChartData, buildDayIndex, countGaps, interpolateAt, valueAt } from '../src/core/series';
import { computeStats } from '../src/core/stats';
import type { Reading } from '../src/core/types';

const TARGET = { low: 3.9, high: 7.8 };
const r = (day: string, min: number, v: number): Reading => ({ day, min, v });

describe('buildDayIndex', () => {
  it('按天分组并排序', () => {
    const index = buildDayIndex([r('2025-03-20', 110, 6.7), r('2025-03-20', 100, 6.6), r('2025-03-19', 10, 5)]);
    expect([...index.keys()]).toEqual(['2025-03-20', '2025-03-19']);
    expect(index.get('2025-03-20')!.map((x) => x.min)).toEqual([100, 110]);
  });
});

describe('valueAt / interpolateAt', () => {
  const day = [r('d', 0, 5), r('d', 10, 7), r('d', 20, 6)];
  it('找最接近的点', () => {
    expect(valueAt(day, 4)).toBe(5);
    expect(valueAt(day, 6)).toBe(7);
    expect(valueAt(day, 100)).toBe(6);
    expect(valueAt(day, -5)).toBe(5);
  });
  it('线性插值', () => {
    expect(interpolateAt(day, 5)).toBeCloseTo(6, 6);
    expect(interpolateAt(day, 15)).toBeCloseTo(6.5, 6);
    expect(interpolateAt(day, -1)).toBe(5);
  });
  it('空数组返回 null', () => {
    expect(valueAt([], 10)).toBeNull();
    expect(interpolateAt([], 10)).toBeNull();
  });
});

describe('buildChartData: 阈值切分与断线', () => {
  it('向上穿过上限时插入交点，并补一个极小点让后一段换色', () => {
    const data = buildChartData([r('d', 0, 6), r('d', 10, 9)], TARGET);
    expect(data).toHaveLength(4);
    const [p0, p1, p2, p3] = data as [number, number][];
    expect(p0).toEqual([0, 6]);
    expect(p1[1]).toBe(7.8);
    expect(p1[0]).toBeCloseTo(6, 6); // (7.8-6)/(9-6)*10
    expect(p2[0]).toBeGreaterThan(p1[0]);
    expect(p2[1]).toBeGreaterThan(7.8);
    expect(p3).toEqual([10, 9]);
  });

  it('向下穿过下限时也会正确切分', () => {
    const data = buildChartData([r('d', 0, 5), r('d', 10, 3)], TARGET);
    const points = data as ([number, number] | null)[];
    const crossing = points.find((p) => p && p[1] === 3.9);
    expect(crossing).toBeTruthy();
    expect(crossing![0]).toBeCloseTo((5 - 3.9) / (5 - 3) * 10, 6);
  });

  it('完全在范围内时不会插入多余的点', () => {
    const data = buildChartData([r('d', 0, 5), r('d', 5, 6), r('d', 10, 5.5)], TARGET);
    expect(data).toHaveLength(3);
  });

  it('缺口处插入 null 断线', () => {
    const data = buildChartData([r('d', 0, 5), r('d', 5, 6), r('d', 65, 6.5)], TARGET);
    expect(data.some((p) => p === null)).toBe(true);
    expect(countGaps([r('d', 0, 5), r('d', 5, 6), r('d', 65, 6.5)])).toBe(1);
  });

  it('一次跨过整个目标区间也能处理', () => {
    const data = buildChartData([r('d', 0, 3), r('d', 10, 9)], TARGET);
    const ys = (data as [number, number][]).map((p) => p[1]);
    expect(ys[0]).toBe(3);
    expect(ys).toContain(3.9);
    expect(ys).toContain(7.8);
    expect(ys[ys.length - 1]).toBe(9);
  });
});

describe('computeStats', () => {
  const readings = [r('d', 0, 3.0), r('d', 5, 5.0), r('d', 10, 8.0), r('d', 15, 11.0)];

  it('TIR / TAR / TBR 按读数占比计算', () => {
    const s = computeStats(readings, TARGET);
    expect(s.count).toBe(4);
    expect(s.tbr).toBeCloseTo(25, 6);
    expect(s.tir).toBeCloseTo(25, 6);
    expect(s.tar).toBeCloseTo(50, 6);
    expect(s.tar2).toBeCloseTo(25, 6); // > 10
    expect(s.tbr2).toBe(0); // 3.0 不算「低于 3.0」
  });

  it('均值、极值、标准差、CV、GMI', () => {
    const s = computeStats(readings, TARGET);
    expect(s.mean).toBeCloseTo(6.75, 6);
    expect(s.min).toBe(3);
    expect(s.max).toBe(11);
    expect(s.sd).toBeCloseTo(3.5, 6);
    expect(s.cv).toBeCloseTo((3.5 / 6.75) * 100, 4);
    expect(s.gmi).toBeCloseTo(3.31 + 0.02392 * (6.75 * 18.0182), 4);
  });

  it('数据完整度按 288 点/天 计算', () => {
    expect(computeStats(readings, TARGET).coverage).toBeCloseTo(4 / 288, 6);
    const full = Array.from({ length: 288 }, (_, i) => r('d', i * 5, 5.5));
    expect(computeStats(full, TARGET).coverage).toBe(1);
  });

  it('没有数据时不会崩', () => {
    const s = computeStats([], TARGET);
    expect(s.count).toBe(0);
    expect(s.tir).toBe(0);
    expect(s.mean).toBe(0);
  });

  it('目标范围可以自定义', () => {
    const s = computeStats([r('d', 0, 4.5), r('d', 5, 9.5)], { low: 4, high: 10 });
    expect(s.tir).toBeCloseTo(100, 6);
  });
});
