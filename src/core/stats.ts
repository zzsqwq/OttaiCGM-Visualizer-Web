/**
 * 血糖统计指标（对齐国际共识的 CGM 指标：TIR / TAR / TBR / CV / GMI）
 */
import type { Reading, TargetRange } from './types';

export interface Stats {
  count: number;
  /** 与 5 分钟一个点相比的数据完整度 */
  coverage: number;
  mean: number;
  min: number;
  max: number;
  sd: number;
  cv: number;
  gmi: number;
  tir: number;
  tar: number;
  tar2: number;
  tbr: number;
  tbr2: number;
  target: TargetRange;
}

export const EMPTY_STATS: Stats = {
  count: 0,
  coverage: 0,
  mean: 0,
  min: 0,
  max: 0,
  sd: 0,
  cv: 0,
  gmi: 0,
  tir: 0,
  tar: 0,
  tar2: 0,
  tbr: 0,
  tbr2: 0,
  target: { low: 3.9, high: 7.8 },
};

export function computeStats(readings: Reading[], target: TargetRange): Stats {
  const n = readings.length;
  if (n === 0) return { ...EMPTY_STATS, target };

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let inRange = 0;
  let above = 0;
  let above2 = 0;
  let below = 0;
  let below2 = 0;

  for (const r of readings) {
    sum += r.v;
    if (r.v < min) min = r.v;
    if (r.v > max) max = r.v;
    if (r.v > target.high) {
      above++;
      if (r.v > 10) above2++;
    } else if (r.v < target.low) {
      below++;
      if (r.v < 3) below2++;
    } else {
      inRange++;
    }
  }

  const mean = sum / n;
  let variance = 0;
  for (const r of readings) variance += (r.v - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(variance / (n - 1)) : 0;
  const mgdl = mean * 18.0182;

  return {
    count: n,
    coverage: Math.min(1, n / 288),
    mean,
    min,
    max,
    sd,
    cv: mean > 0 ? (sd / mean) * 100 : 0,
    gmi: 3.31 + 0.02392 * mgdl,
    tir: (inRange / n) * 100,
    tar: (above / n) * 100,
    tar2: (above2 / n) * 100,
    tbr: (below / n) * 100,
    tbr2: (below2 / n) * 100,
    target,
  };
}

export function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}
