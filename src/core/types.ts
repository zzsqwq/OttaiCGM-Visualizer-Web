/**
 * 数据模型
 *
 * 时间统一用「本地墙钟时间」表示，避免时区/夏令时带来的偏移问题：
 *   - day: 'YYYY-MM-DD'
 *   - min: 当天 00:00 起的分钟数（允许小数，例如 12:07:30 -> 727.5）
 */

/** 单个血糖读数 */
export interface Reading {
  day: string;
  min: number;
  /** mmol/L */
  v: number;
}

/** 一条活动标注（用户手写） */
export interface Annotation {
  id: string;
  day: string;
  /** 锚点时间（分钟），决定 x 位置与所指向的血糖点 */
  min: number;
  text: string;
  /** 纵向偏移，单位 mmol/L；>0 在曲线上方，<0 在下方 */
  offset: number;
}

/** 自动检出的血糖峰值 */
export interface Peak {
  day: string;
  min: number;
  v: number;
}

/** 一次导入的来源信息 */
export interface SourceInfo {
  name: string;
  readings: number;
  skipped: number;
  /** 被忽略/覆盖的重复时间点数量 */
  duplicates: number;
  unit: 'mmol/L' | 'mg/dL';
  kind: 'glucose' | 'annotations';
}

export interface Dataset {
  /** 血糖数据，按 (day, min) 升序 */
  readings: Reading[];
  /** 有数据的日期，升序 */
  days: string[];
  sources: SourceInfo[];
  /** mg/dL 被换算过 */
  convertedFromMgDl: boolean;
  loadedAt: number;
}

export interface TargetRange {
  low: number;
  high: number;
}

export const DEFAULT_TARGET: TargetRange = { low: 3.9, high: 7.8 };
