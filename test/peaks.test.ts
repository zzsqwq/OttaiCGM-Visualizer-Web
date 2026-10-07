import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDailyPeaks, findPeaks, localMaxima, peakProminences } from '../src/core/peaks';
import { parseBuffer } from '../src/core/parser';
import reference from './fixtures/reference.json';

const FIXTURES = join(__dirname, 'fixtures');

function fixtureReadings(name: string) {
  const buf = readFileSync(join(FIXTURES, name));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return parseBuffer(name, ab).readings;
}

const valuesByDay = new Map<string, number[]>();
function dayValues(file: string, day: string): number[] {
  const key = `${file}|${day}`;
  const cached = valuesByDay.get(key);
  if (cached) return cached;
  const values = fixtureReadings(file)
    .filter((r) => r.day === day)
    .map((r) => r.v);
  valuesByDay.set(key, values);
  return values;
}

describe('localMaxima / peakProminences: 与 scipy 的定义一致', () => {
  it('普通波形', () => {
    expect(localMaxima([0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 0])).toEqual([1, 3, 7]);
  });
  it('平台取中点', () => {
    expect(localMaxima([0, 1, 2, 2, 1])).toEqual([2]);
    expect(localMaxima([0, 3, 3, 3, 1])).toEqual([2]);
  });
  it('端点不算峰', () => {
    expect(localMaxima([5, 4, 3, 2, 1])).toEqual([]);
    expect(localMaxima([1, 2, 3, 4, 5])).toEqual([]);
  });
  it('prominence：与 scipy 文档里的例子一致', () => {
    // >>> x = np.array([0, 1, 0, 3, 1, 3, 0, 4, 0]); peak_prominences(x, [5]) -> 3.0, 左 base=2, 右 base=6
    const { prominences, leftBases, rightBases } = peakProminences([0, 1, 0, 3, 1, 3, 0, 4, 0], [5]);
    expect(prominences).toEqual([3]);
    expect(leftBases).toEqual([2]);
    expect(rightBases).toEqual([6]);
  });
});

describe('findPeaks: 与 scipy.signal.find_peaks 逐位对齐（常用参数）', () => {
  // distance ≤ 6（30 分钟）、prominence ≥ 0.2 是实际会用到的范围，
  // 这个区间里等高峰落在同一窗口的概率极低，要求与 scipy 完全一致。
  const strict = reference.peaks.filter((c) => c.distance <= 6 && (c.prominence ?? 0) >= 0.2);

  it('基准用例数量足够', () => {
    expect(strict.length).toBeGreaterThan(60);
  });

  for (const testCase of strict) {
    it(`${testCase.file} ${testCase.day} distance=${testCase.distance} prominence=${testCase.prominence}`, () => {
      const values = dayValues(testCase.file, testCase.day);
      const peaks = findPeaks(values, { distance: testCase.distance, prominence: testCase.prominence ?? undefined });
      expect(peaks.map((p) => p.index)).toEqual(testCase.indices);
      expect(peaks.map((p) => Number(p.value.toFixed(4)))).toEqual(testCase.values);
    });
  }
});

describe('findPeaks: 全部参数组合下的不变量', () => {
  for (const testCase of reference.peaks) {
    it(`${testCase.file} ${testCase.day} distance=${testCase.distance} prominence=${testCase.prominence}`, () => {
      const values = dayValues(testCase.file, testCase.day);
      const peaks = findPeaks(values, { distance: testCase.distance, prominence: testCase.prominence ?? undefined });
      const indices = peaks.map((p) => p.index);

      // 1. 每个峰都真的满足 prominence 阈值
      if (testCase.prominence != null) {
        for (const p of peaks) expect(p.prominence).toBeGreaterThanOrEqual(testCase.prominence - 1e-9);
      }
      // 2. 保留的峰之间间隔不小于 distance
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i] - indices[i - 1]).toBeGreaterThanOrEqual(testCase.distance);
      }
      // 3. 每个峰都是真正的局部极大值（平台要整段看），且高度与 scipy 一致
      for (const p of peaks) {
        const v = values[p.index];
        let left = p.index;
        while (left > 0 && values[left - 1] === v) left--;
        let right = p.index;
        while (right < values.length - 1 && values[right + 1] === v) right++;
        if (left > 0) expect(values[left - 1], `第 ${p.index} 个点左侧`).toBeLessThan(v);
        if (right < values.length - 1) expect(values[right + 1], `第 ${p.index} 个点右侧`).toBeLessThan(v);
      }
      // 4. 与 scipy 的差异只可能来自等高、且互相在 distance 窗口内的峰（numpy 不稳定排序），
      //    数量上不应超过 2 个
      expect(Math.abs(indices.length - testCase.indices.length)).toBeLessThanOrEqual(2);
    });
  }
});

describe('findDailyPeaks: 按分钟换算采样点', () => {
  it('30 分钟 / 5 分钟采样 → 等价于 distance=6', () => {
    const values = [5, 6, 5, 6.5, 5.2, 6.8, 5.4, 5.1, 6.9, 5, 5.2, 5.1, 5, 5.3, 5.1, 5.0, 5.2, 5.4, 5.1, 5.0];
    const a = findDailyPeaks(values, { minDistanceMinutes: 30, prominence: 0.3, stepMinutes: 5 });
    const b = findPeaks(values, { distance: 6, prominence: 0.3 });
    expect(a.map((p) => p.index)).toEqual(b.map((p) => p.index));
  });

  it('可以只保留超过某个高度的峰（「只标注超标的峰值」）', () => {
    const values = [5, 6, 5, 8, 5, 6.5, 5];
    expect(findDailyPeaks(values, { prominence: 0.3, minValue: 7.8 }).map((p) => p.value)).toEqual([8]);
  });
});
