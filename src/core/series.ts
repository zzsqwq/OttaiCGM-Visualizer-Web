/**
 * 序列处理：按天分组、找最近点、为图表做阈值切分、缺口检测
 */
import type { Reading, TargetRange } from './types';

export type DayIndex = Map<string, Reading[]>;

/** 按天分组（输入已排序时输出也有序） */
export function buildDayIndex(readings: Reading[]): DayIndex {
  const map: DayIndex = new Map();
  for (const r of readings) {
    const list = map.get(r.day);
    if (list) list.push(r);
    else map.set(r.day, [r]);
  }
  for (const list of map.values()) list.sort((a, b) => a.min - b.min);
  return map;
}

/** 找与 min 最接近的读数值 */
export function valueAt(readings: Reading[], min: number): number | null {
  if (!readings.length) return null;
  let lo = 0;
  let hi = readings.length - 1;
  if (min <= readings[0].min) return readings[0].v;
  if (min >= readings[hi].min) return readings[hi].v;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (readings[mid].min < min) lo = mid + 1;
    else hi = mid;
  }
  const right = readings[lo];
  const left = readings[lo - 1] ?? right;
  return Math.abs(left.min - min) <= Math.abs(right.min - min) ? left.v : right.v;
}

/** 线性插值（用于图表上的连续读数） */
export function interpolateAt(readings: Reading[], min: number): number | null {
  if (!readings.length) return null;
  if (min <= readings[0].min) return readings[0].v;
  const last = readings[readings.length - 1];
  if (min >= last.min) return last.v;
  let lo = 0;
  let hi = readings.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (readings[mid].min < min) lo = mid + 1;
    else hi = mid;
  }
  const right = readings[lo];
  const left = readings[lo - 1] ?? right;
  if (right.min === left.min) return right.v;
  const t = (min - left.min) / (right.min - left.min);
  return left.v + t * (right.v - left.v);
}

/** 相邻两点超过这个间隔就认为传感器断了，画图时断开 */
export const GAP_MINUTES = 15;

const EPS_TIME = 1 / 120; // 30 秒
const EPS_VALUE = 0.001;

/**
 * 为折线图准备数据：在目标范围上下限处插入交点，
 * 使得 ECharts 的 visualMap 能做到「刚好在 7.8 变色」的效果。
 * 缺口处插入 null 断线。
 */
export function buildChartData(readings: Reading[], target: TargetRange): (null | [number, number])[] {
  const out: (null | [number, number])[] = [];
  const { low, high } = target;
  const thresholds = [low, high];

  const crosses = (y1: number, y2: number, level: number): boolean =>
    (y1 < level && y2 > level) || (y1 > level && y2 < level);

  for (let i = 0; i < readings.length; i++) {
    const cur = readings[i];
    out.push([cur.min, cur.v]);
    const next = readings[i + 1];
    if (!next) continue;
    if (next.min - cur.min > GAP_MINUTES) {
      out.push(null);
      continue;
    }
    for (const level of thresholds) {
      if (!crosses(cur.v, next.v, level)) continue;
      const t = (level - cur.v) / (next.v - cur.v);
      const x = cur.min + t * (next.min - cur.min);
      out.push([x, level]);
      // 离开目标区间时（向上穿过上限 / 向下穿过下限），
      // 再补一个极小的点，让后一段线用「新颜色」绘制
      const leavingUp = cur.v < level && next.v > level && level === high;
      const leavingDown = cur.v > level && next.v < level && level === low;
      if (leavingUp) out.push([x + EPS_TIME, level + EPS_VALUE]);
      if (leavingDown) out.push([x + EPS_TIME, level - EPS_VALUE]);
    }
  }
  return out;
}

/** 统计缺口数量（> GAP_MINUTES 的断点） */
export function countGaps(readings: Reading[]): number {
  let gaps = 0;
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].min - readings[i - 1].min > GAP_MINUTES) gaps++;
  }
  return gaps;
}
