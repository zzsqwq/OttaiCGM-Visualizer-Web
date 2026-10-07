/**
 * 导入解析：把欧态血糖仪导出的 Excel / CSV（以及本应用导出的 CSV、JSON）解析成统一模型。
 *
 * 设计原则：
 * 1. 只认字符串本身，不依赖时区 —— 时间按「墙上时间」处理。
 * 2. 尽量宽容：列名、日期格式、单位（mmol/L、mg/dL）都能自动识别。
 * 3. 解析不了的行直接跳过并计数，不抛异常，最后统一汇报。
 */
import * as XLSX from 'xlsx';
import type { Annotation, Reading, SourceInfo } from './types';
import { parseCsv, decodeText } from './csv';
import { guessDayFromFilename, parseClock, parseDateTime, parseDayOnly } from './time';

export interface ParsedAnnotationDraft {
  day: string | null;
  min: number;
  text: string;
  offset: number;
  /** 来自示例数据（备份文件里会带上） */
  sample?: boolean;
  /** 来自哪个文件 */
  source?: string;
}

export interface ParseOutcome {
  kind: 'glucose' | 'annotations' | 'workspace' | 'unknown';
  readings: Reading[];
  annotations: ParsedAnnotationDraft[];
  settings?: Record<string, unknown>;
  source: SourceInfo;
  /** JSON 备份里带的原始来源列表（保留「示例」标记） */
  sources?: SourceInfo[];
  warnings: string[];
}

const RE_TIME = /(时刻|时间|日期|date|time|datetime|timestamp)/i;
const RE_VALUE = /(血糖|葡萄糖|glucose|sgv|cgm|mmol|mg\/?\s?dl|数值|值)/i;
const RE_TEXT = /(活动|描述|内容|注释|标注|备注|note|text|content|comment|annotation|desc)/i;
const RE_OFFSET = /(偏移|offset|y\s*偏移|位置)/i;
const RE_DAY = /(日期|date|day)/i;

/** 把任意单元格转成字符串用于判断表头 */
function cellText(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function looksLikeHeaderTime(v: unknown): boolean {
  const s = cellText(v);
  return s.length > 0 && s.length <= 12 && RE_TIME.test(s) && !/\d{1,2}[:：]\d{2}/.test(s);
}

/** 解析血糖数值（可能是数字、带单位的字符串） */
export function parseGlucoseValue(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  if (!s) return null;
  // 'LO' / '低' 这类无具体数值的记录直接跳过
  if (/^(lo|hi|low|high|低|高)$/i.test(s)) return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(s);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const MGDL_TO_MMOL = 1 / 18.0182;

function matrixFromXlsx(buf: ArrayBuffer): unknown[][] {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  });
}

/** 找到表头行：同一行里既有时间列又有血糖列 */
function findGlucoseHeader(rows: unknown[][]): { row: number; timeCol: number; valueCol: number; dateCol: number } | null {
  const limit = Math.min(rows.length, 20);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] ?? [];
    let timeCol = -1;
    let dateCol = -1;
    let valueCol = -1;
    for (let c = 0; c < row.length; c++) {
      const s = cellText(row[c]);
      if (!s) continue;
      if (looksLikeHeaderTime(s)) {
        if (/日期|date|day/i.test(s) && !/时刻|时间|time/i.test(s)) {
          if (dateCol < 0) dateCol = c;
        } else if (timeCol < 0) {
          timeCol = c;
        }
        continue;
      }
      if (valueCol < 0 && RE_VALUE.test(s) && !RE_TIME.test(s)) valueCol = c;
    }
    if (timeCol >= 0 && valueCol >= 0 && valueCol !== timeCol) {
      return { row: r, timeCol, valueCol, dateCol };
    }
    // 「日期 + 时间」分成两列的情况
    if (dateCol >= 0 && timeCol >= 0 && valueCol >= 0) {
      return { row: r, timeCol, valueCol, dateCol };
    }
  }
  return null;
}

function findAnnotationHeader(rows: unknown[][]): { row: number; timeCol: number; textCol: number; offsetCol: number; dateCol: number } | null {
  const limit = Math.min(rows.length, 10);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] ?? [];
    let timeCol = -1;
    let textCol = -1;
    let offsetCol = -1;
    let dateCol = -1;
    for (let c = 0; c < row.length; c++) {
      const s = cellText(row[c]);
      if (!s) continue;
      if (RE_TEXT.test(s) && textCol < 0) {
        textCol = c;
        continue;
      }
      if (RE_OFFSET.test(s) && offsetCol < 0) {
        offsetCol = c;
        continue;
      }
      // 注意顺序：「日期(可选)」这种列名也含「日期」，要先判断日期列
      if (RE_DAY.test(s) && dateCol < 0) {
        dateCol = c;
        continue;
      }
      if (RE_TIME.test(s) && timeCol < 0) timeCol = c;
    }
    if (timeCol >= 0 && textCol >= 0) return { row: r, timeCol, textCol, offsetCol, dateCol };
  }
  return null;
}

function guessFilenameDay(name: string): string | null {
  return guessDayFromFilename(name.replace(/\.[^.]+$/, ''));
}

/** 解析血糖表 */
function parseGlucoseMatrix(
  rows: unknown[][],
  fileName: string,
): { readings: Reading[]; source: SourceInfo; warnings: string[] } {
  const warnings: string[] = [];
  let header = findGlucoseHeader(rows);
  let startRow: number;
  let timeCol: number;
  let valueCol: number;
  let dateCol: number;

  if (header) {
    startRow = header.row + 1;
    timeCol = header.timeCol;
    valueCol = header.valueCol;
    dateCol = header.dateCol;
  } else {
    warnings.push(`「${fileName}」没找到表头，按前两列（时间, 血糖值）解析`);
    startRow = 0;
    timeCol = 0;
    valueCol = 1;
    dateCol = -1;
  }

  const headerText = header ? (rows[header.row] ?? []).map(cellText).join(' ') : '';
  let unit: 'mmol/L' | 'mg/dL' = /mg\s*\/?\s*dl/i.test(headerText) ? 'mg/dL' : 'mmol/L';

  const rawReadings: Reading[] = [];
  const rawValues: number[] = [];
  let skipped = 0;
  let lastDay: string | null = null;

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const timeCell = row[timeCol];
    const timeText = cellText(timeCell);
    let parsed: { day: string; min: number } | null = null;

    if (dateCol >= 0) {
      // 「日期」和「时间」分成两列：日期必须以本行的日期列为准。
      // 这里曾经先用 parseDateTime(timeCell, lastDay) 兜底，导致只有时分秒的
      // 单元格全部沿用上一行的日期 —— 多天数据会被压成第一天。
      const full = /\d{4}/.test(timeText) ? parseDateTime(timeCell) : null;
      const day: string | null = parseDayOnly(row[dateCol]) ?? full?.day ?? lastDay;
      const min = parseClock(timeCell) ?? full?.min ?? null;
      if (day && min != null) parsed = { day, min };
    } else {
      parsed = parseDateTime(timeCell, lastDay ?? undefined);
    }

    const value = parseGlucoseValue(row[valueCol]);

    if (!parsed || value == null) {
      if (cellText(timeCell) || cellText(row[valueCol])) skipped++;
      continue;
    }
    lastDay = parsed.day;
    rawReadings.push({ day: parsed.day, min: parsed.min, v: value });
    rawValues.push(value);
  }

  // 单位判断：表头没写清楚时，用中位数猜（血糖 mmol/L 通常 4~15，mg/dL 通常 70~250）
  if (unit === 'mmol/L' && rawValues.length > 0 && median(rawValues) > 35) {
    unit = 'mg/dL';
  }

  const factor = unit === 'mg/dL' ? MGDL_TO_MMOL : 1;
  const readings: Reading[] = [];
  for (const item of rawReadings) {
    const v = Math.round(item.v * factor * 100) / 100;
    // 生理上不可能的值直接丢掉（传感器异常点）
    if (v <= 0.5 || v > 40) {
      skipped++;
      continue;
    }
    readings.push({ day: item.day, min: item.min, v });
  }

  if (unit === 'mg/dL') {
    warnings.push(`「${fileName}」检测到 mg/dL 单位，已自动换算为 mmol/L`);
  }
  if (skipped > 0) {
    warnings.push(`「${fileName}」有 ${skipped} 行无法解析，已跳过`);
  }

  // 欧态导出的顺序是「由新到旧」，这里统一按 (日期, 时间) 升序并去重
  const merged = mergeReadings(readings, []).readings;
  if (merged.length !== readings.length) skipped += readings.length - merged.length;

  return {
    readings: merged,
    warnings,
    source: {
      name: fileName,
      readings: merged.length,
      skipped,
      duplicates: 0,
      unit,
      kind: 'glucose',
    },
  };
}

/** 解析活动标注表 */
function parseAnnotationMatrix(
  rows: unknown[][],
  fileName: string,
): { annotations: ParsedAnnotationDraft[]; source: SourceInfo; warnings: string[] } {
  const warnings: string[] = [];
  const header = findAnnotationHeader(rows);
  let startRow: number;
  let timeCol = 0;
  let textCol = 1;
  let offsetCol = 2;
  let dateCol = -1;

  if (header) {
    startRow = header.row + 1;
    timeCol = header.timeCol;
    textCol = header.textCol;
    offsetCol = header.offsetCol;
    dateCol = header.dateCol;
  } else {
    startRow = 0;
    warnings.push(`「${fileName}」按「时间, 描述, Y偏移量, 日期」解析标注`);
  }

  const fileDay = guessFilenameDay(fileName);
  const annotations: ParsedAnnotationDraft[] = [];
  let skipped = 0;

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const text = cellText(row[textCol]);
    if (!text) continue;
    const timeCell = row[timeCol];
    let min = parseClock(timeCell);
    let day: string | null = null;

    const asDate = parseDateTime(timeCell);
    if (asDate && /\d{4}/.test(cellText(timeCell))) {
      day = asDate.day;
      if (min == null) min = asDate.min;
    }
    if (day == null && dateCol >= 0) day = parseDayOnly(row[dateCol]);
    if (day == null) day = fileDay;
    if (min == null) {
      skipped++;
      continue;
    }

    let offset = 0;
    if (offsetCol >= 0) {
      const parsedOffset = parseGlucoseValue(row[offsetCol]);
      if (parsedOffset != null && Math.abs(parsedOffset) < 100) offset = parsedOffset;
    }

    annotations.push({ day, min, text, offset });
  }

  if (fileDay) warnings.push(`「${fileName}」未标注日期，已按文件名归到 ${fileDay}`);
  if (skipped > 0) warnings.push(`「${fileName}」有 ${skipped} 行时间无法解析，已跳过`);

  return {
    annotations,
    warnings,
    source: {
      name: fileName,
      readings: annotations.length,
      skipped,
      duplicates: 0,
      unit: 'mmol/L',
      kind: 'annotations',
    },
  };
}

interface WorkspaceLike {
  app?: string;
  readings?: unknown;
  annotations?: unknown;
  settings?: Record<string, unknown>;
  sources?: unknown;
}

function parseWorkspace(json: WorkspaceLike, fileName: string): ParseOutcome | null {
  if (json.app !== 'ottai-cgm-visualizer' && !json.readings) return null;
  const readings: Reading[] = [];
  const annotations: ParsedAnnotationDraft[] = [];
  const raw = json.readings;

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const day = typeof o.day === 'string' ? o.day : typeof o.d === 'string' ? o.d : null;
      const min = typeof o.min === 'number' ? o.min : typeof o.m === 'number' ? o.m : null;
      const v = typeof o.v === 'number' ? o.v : typeof o.value === 'number' ? o.value : null;
      if (day && min != null && v != null) readings.push({ day, min, v });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [day, arr] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const min = Number(arr[i]);
        const v = Number(arr[i + 1]);
        if (Number.isFinite(min) && Number.isFinite(v)) readings.push({ day, min, v });
      }
    }
  }

  if (Array.isArray(json.annotations)) {
    for (const item of json.annotations) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const day = typeof o.day === 'string' ? o.day : null;
      const min = typeof o.min === 'number' ? o.min : null;
      const text = typeof o.text === 'string' ? o.text : '';
      const offset = typeof o.offset === 'number' ? o.offset : 0;
      if (min != null && text) {
        annotations.push({
          day,
          min,
          text,
          offset,
          ...(o.sample ? { sample: true } : {}),
          ...(typeof o.source === 'string' ? { source: o.source } : {}),
        });
      }
    }
  }

  return {
    kind: 'workspace',
    readings,
    annotations,
    settings: json.settings,
    sources: Array.isArray(json.sources) ? (json.sources as SourceInfo[]) : undefined,
    warnings: [],
    source: {
      name: fileName,
      readings: readings.length,
      skipped: 0,
      duplicates: 0,
      unit: 'mmol/L',
      kind: 'glucose',
    },
  };
}

/** 同步解析一个文件的内容（供测试与 Web Worker 复用） */
export function parseBuffer(fileName: string, buf: ArrayBuffer): ParseOutcome {
  const lower = fileName.toLowerCase();
  let rows: unknown[][] | null = null;
  let text: string | null = null;

  try {
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')) {
      rows = matrixFromXlsx(buf);
    } else {
      text = decodeText(buf);
      if (lower.endsWith('.json')) {
        try {
          const json = JSON.parse(text) as WorkspaceLike | unknown[];
          if (Array.isArray(json)) {
            const readings: Reading[] = [];
            for (const item of json) {
              if (!item || typeof item !== 'object') continue;
              const o = item as Record<string, unknown>;
              const day = typeof o.day === 'string' ? o.day : null;
              const min = typeof o.min === 'number' ? o.min : null;
              const v = typeof o.v === 'number' ? o.v : null;
              if (day && min != null && v != null) readings.push({ day, min, v });
            }
            if (readings.length) {
              return {
                kind: 'glucose',
                readings,
                annotations: [],
                warnings: [],
                source: { name: fileName, readings: readings.length, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
              };
            }
          } else {
            const ws = parseWorkspace(json as WorkspaceLike, fileName);
            if (ws) return ws;
          }
        } catch {
          // 不是 JSON，继续按 CSV 处理
        }
      }
      rows = parseCsv(text);
    }
  } catch (err) {
    return {
      kind: 'unknown',
      readings: [],
      annotations: [],
      warnings: [`「${fileName}」解析失败：${(err as Error).message}`],
      source: { name: fileName, readings: 0, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
    };
  }

  if (!rows || rows.length === 0) {
    return {
      kind: 'unknown',
      readings: [],
      annotations: [],
      warnings: [`「${fileName}」没有可读取的内容`],
      source: { name: fileName, readings: 0, skipped: 0, duplicates: 0, unit: 'mmol/L', kind: 'glucose' },
    };
  }

  const annotationHeader = findAnnotationHeader(rows);
  const glucoseHeader = findGlucoseHeader(rows);

  // 标注表优先：有「活动描述」这类列就按标注解析
  if (annotationHeader && (!glucoseHeader || annotationHeader.row < glucoseHeader.row + 2)) {
    const res = parseAnnotationMatrix(rows, fileName);
    if (res.annotations.length > 0) {
      return { kind: 'annotations', readings: [], annotations: res.annotations, warnings: res.warnings, source: res.source };
    }
  }

  const res = parseGlucoseMatrix(rows, fileName);
  if (res.readings.length === 0 && annotationHeader) {
    const ann = parseAnnotationMatrix(rows, fileName);
    return { kind: 'annotations', readings: [], annotations: ann.annotations, warnings: ann.warnings, source: ann.source };
  }
  return { kind: 'glucose', readings: res.readings, annotations: [], warnings: res.warnings, source: res.source };
}

export async function parseFile(file: File): Promise<ParseOutcome> {
  const buf = await file.arrayBuffer();
  return parseBuffer(file.name, buf);
}

/** 合并多份导入结果：同一天同一时刻以「后导入的文件」为准 */
export function mergeReadings(
  incoming: Reading[],
  existing: Reading[] = [],
): { readings: Reading[]; duplicates: number } {
  const map = new Map<string, Reading>();
  let duplicates = 0;
  for (const r of existing) map.set(`${r.day}|${Math.round(r.min * 60)}`, r);
  for (const r of incoming) {
    const key = `${r.day}|${Math.round(r.min * 60)}`;
    if (map.has(key)) duplicates++;
    map.set(key, r);
  }
  const readings = [...map.values()].sort((a, b) => (a.day === b.day ? a.min - b.min : a.day < b.day ? -1 : 1));
  return { readings, duplicates };
}

export function annotationFromDraft(draft: ParsedAnnotationDraft, day: string, makeId: () => string): Annotation {
  return {
    id: makeId(),
    day: draft.day ?? day,
    min: draft.min,
    text: draft.text,
    offset: draft.offset,
  };
}
