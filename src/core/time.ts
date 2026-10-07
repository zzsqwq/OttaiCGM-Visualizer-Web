/**
 * 时间解析与格式化
 *
 * 欧态血糖仪导出的 Excel 里，「时刻」列是形如 `2025.3.20 01:45` 的字符串，
 * 也有可能是 Excel 日期序列号或者真正的日期单元格，这里统一兼容。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function dayKey(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 'YYYY-MM-DD' -> {y,m,d} */
export function splitDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

/** 分钟 -> 'HH:mm' */
export function formatHM(min: number): string {
  let m = Math.round(min);
  if (m < 0) m = 0;
  if (m > 1440) m = 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h >= 24) return '24:00';
  return `${pad2(h)}:${pad2(mm)}`;
}

/** 分钟 -> 'HH:mm:ss'（保留秒，用于数据点提示） */
export function formatHMS(min: number): string {
  const total = Math.round(min * 60);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** 'YYYY-MM-DD' -> '2025年3月20日' */
export function formatDayCn(day: string): string {
  const { y, m, d } = splitDay(day);
  return `${y}年${m}月${d}日`;
}

/** 'YYYY-MM-DD' -> '3月20日' */
export function formatDayShortCn(day: string): string {
  const { m, d } = splitDay(day);
  return `${m}月${d}日`;
}

/** 'YYYY-MM-DD' -> '周四' */
export function weekdayCn(day: string): string {
  const { y, m, d } = splitDay(day);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return WEEKDAYS[dt.getUTCDay()];
}

/** 'YYYY-MM-DD' -> '2025-03-20'（已是该格式则原样返回） */
export function normalizeDay(day: string): string {
  const { y, m, d } = splitDay(day);
  return dayKey(y, m, d);
}

/** 两个日期相差天数 */
export function dayDiff(a: string, b: string): number {
  const pa = splitDay(a);
  const pb = splitDay(b);
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d);
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((tb - ta) / 86400000);
}

export function shiftDay(day: string, deltaDays: number): string {
  const { y, m, d } = splitDay(day);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Excel 序列号（1900 日期系统）-> UTC 毫秒 */
function excelSerialToMs(serial: number): number {
  // 25569 = 1970-01-01 的 Excel 序列号；Excel 把 1900 当闰年，1900-03-01 之后可直接换算
  return Math.round((serial - 25569) * 86400000);
}

export interface ParsedTime {
  day: string;
  min: number;
}

function fromParts(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): ParsedTime | null {
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 24 || mi > 59 || s > 59) return null;
  const day = dayKey(y, mo, d);
  // 校验日期真实存在（例如 2 月 30 日）
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const min = h * 60 + mi + s / 60;
  return { day, min: Math.min(min, 1440) };
}

/** 由 UTC 毫秒取「墙钟」日期与分钟 */
function fromUtcMs(ms: number): ParsedTime {
  const dt = new Date(ms);
  return {
    day: dayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()),
    min: dt.getUTCHours() * 60 + dt.getUTCMinutes() + dt.getUTCSeconds() / 60,
  };
}

const RE_YMD_HM =
  /^(\d{4})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?[ T]+(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/;
const RE_DMY_HM =
  /^(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{4})\s*[ T]+(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/;
const RE_YMD = /^(\d{4})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?$/;
const RE_HM = /^(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?$/;
const RE_COMPACT = /^(\d{4})(\d{2})(\d{2})(?:\s*(\d{2})(\d{2})(\d{2})?)?$/;

/**
 * 解析一个「日期+时间」单元格。支持：
 * - '2025.3.20 01:45' / '2025-03-20 01:45' / '2025/3/20 01:45' / '2025年3月20日 01:45'
 * - Excel 序列号（数字）
 * - '2025-03-20T01:45:00Z'（按墙上时间处理）/ Date 对象 / '20250320014500'
 * - 只有时间 '01:45'（需要外部提供日期）
 */
export function parseDateTime(input: unknown, fallbackDay?: string): ParsedTime | null {
  if (input == null) return null;

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return {
      day: dayKey(input.getFullYear(), input.getMonth() + 1, input.getDate()),
      min: input.getHours() * 60 + input.getMinutes() + input.getSeconds() / 60,
    };
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    // 纯时间（0~1 之间的小数，Excel 的时间序列号）
    if (input >= 0 && input < 1) {
      if (!fallbackDay) return null;
      return { day: normalizeDay(fallbackDay), min: Math.round(input * 1440 * 60) / 60 };
    }
    // Excel 日期序列号
    if (input > 20000 && input < 80000) return fromUtcMs(excelSerialToMs(input));
    // 20250320 / 20250320014500 这类整数
    const s = String(Math.trunc(input));
    const m = RE_COMPACT.exec(s);
    if (m) {
      const t = fromParts(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        m[4] ? Number(m[4]) : 0,
        m[5] ? Number(m[5]) : 0,
        m[6] ? Number(m[6]) : 0,
      );
      if (t) return t;
    }
    return null;
  }

  let s = String(input).trim();
  if (!s) return null;
  // 去掉 BOM、全角空格
  s = s.replace(/^\uFEFF/, '').replace(/\u3000/g, ' ').trim();

  // 纯数字字符串按数字再来一次
  if (/^\d+(\.\d+)?$/.test(s) && s.length >= 5) {
    const n = Number(s);
    if (n > 20000 && n < 80000) return fromUtcMs(excelSerialToMs(n));
    const cm = RE_COMPACT.exec(s);
    if (cm) {
      const t = fromParts(
        Number(cm[1]),
        Number(cm[2]),
        Number(cm[3]),
        cm[4] ? Number(cm[4]) : 0,
        cm[5] ? Number(cm[5]) : 0,
        cm[6] ? Number(cm[6]) : 0,
      );
      if (t) return t;
    }
  }

  // 去掉行尾的时区标记，按墙上时间解释
  s = s.replace(/Z$/i, '').replace(/([+-]\d{2}:?\d{2})$/, '').trim();

  let m = RE_YMD_HM.exec(s);
  if (m) return fromParts(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);

  m = RE_DMY_HM.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    // 第一位 > 12 时按 日/月/年
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    return fromParts(+m[3], mo, d, +m[4], +m[5], m[6] ? +m[6] : 0);
  }

  m = RE_YMD.exec(s);
  if (m) return fromParts(+m[1], +m[2], +m[3]);

  m = RE_HM.exec(s);
  if (m && fallbackDay) {
    return fromParts(
      splitDay(fallbackDay).y,
      splitDay(fallbackDay).m,
      splitDay(fallbackDay).d,
      +m[1],
      +m[2],
      m[3] ? +m[3] : 0,
    );
  }

  // 最后兜底：交给 Date 解析（ISO 等），按 UTC 墙钟取
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return fromUtcMs(t);
  return null;
}

/** 解析 'YYYY-MM-DD' / '2025/3/20' / '2025年3月20日' 这类纯日期 */
export function parseDayOnly(input: unknown): string | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return dayKey(input.getFullYear(), input.getMonth() + 1, input.getDate());
  }
  if (typeof input === 'number' && input > 20000 && input < 80000) {
    return fromUtcMs(excelSerialToMs(input)).day;
  }
  let s = String(input).trim().replace(/^\uFEFF/, '');
  if (!s) return null;
  if (/^\d{8}$/.test(s)) {
    const t = fromParts(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    return t ? t.day : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  s = s.replace(/Z$/i, '').trim();
  const m = RE_YMD.exec(s);
  if (m) {
    const t = fromParts(+m[1], +m[2], +m[3]);
    return t ? t.day : null;
  }
  const hm = RE_YMD_HM.exec(s) ?? RE_DMY_HM.exec(s);
  if (hm) {
    const t = parseDateTime(s);
    return t ? t.day : null;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return fromUtcMs(t).day;
  return null;
}

/** 解析 'HH:mm'（导入旧版注释 CSV 用），返回分钟数 */
export function parseClock(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number' && input >= 0 && input < 1) return Math.round(input * 1440 * 60) / 60;
  if (input instanceof Date) return input.getHours() * 60 + input.getMinutes();
  const s = String(input).trim();
  const m = RE_HM.exec(s);
  if (m) {
    const h = +m[1];
    const mi = +m[2];
    const sec = m[3] ? +m[3] : 0;
    if (h <= 24 && mi <= 59) return Math.min(h * 60 + mi + sec / 60, 1440);
  }
  // '2025.3.20 01:45' 形式
  const t = parseDateTime(s);
  if (t) return t.min;
  return null;
}

/** 从文件名里猜日期，例如 annotations-20250317.csv / OttaiCGM_20250320.xlsx */
export function guessDayFromFilename(name: string): string | null {
  const m = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(name);
  if (!m) return null;
  const t = fromParts(+m[1], +m[2], +m[3]);
  return t ? t.day : null;
}
