import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBuffer, mergeReadings } from '../src/core/parser';
import { toCsv } from '../src/core/csv';
import reference from './fixtures/reference.json';

const FIXTURES = join(__dirname, 'fixtures');

function loadFixture(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

describe('parseBuffer: 欧态导出的 xlsx', () => {
  for (const [name, expected] of Object.entries(reference.files)) {
    it(`${name} 的每个日期、点数、首尾时间都与 openpyxl 一致`, () => {
      const outcome = parseBuffer(name, loadFixture(name));
      expect(outcome.kind).toBe('glucose');
      expect(outcome.readings.length).toBe(expected.total);

      const byDay = new Map<string, { min: number; v: number }[]>();
      for (const r of outcome.readings) {
        const list = byDay.get(r.day) ?? [];
        list.push(r);
        byDay.set(r.day, list);
      }
      expect([...byDay.keys()].sort()).toEqual(Object.keys(expected.days).sort());

      for (const [day, exp] of Object.entries(expected.days)) {
        const rows = (byDay.get(day) ?? []).sort((a, b) => a.min - b.min);
        expect(rows.length, `${day} 点数`).toBe(exp.count);
        expect([rows[0].min, rows[0].v], `${day} 首点`).toEqual([exp.first[0], exp.first[1]]);
        expect([rows[rows.length - 1].min, rows[rows.length - 1].v], `${day} 末点`).toEqual([exp.last[0], exp.last[1]]);
        const values = rows.map((r) => r.v);
        expect(Math.min(...values)).toBeCloseTo(exp.min, 5);
        expect(Math.max(...values)).toBeCloseTo(exp.max, 5);
        expect(mean(values)).toBeCloseTo(exp.mean, 3);
      }
    });
  }

  it('解析结果按 (日期, 时间) 排序，且同一天内没有重复时间点', () => {
    const outcome = parseBuffer('OttaiCGM_20250330.xlsx', loadFixture('OttaiCGM_20250330.xlsx'));
    let prev = -1;
    let prevDay = '';
    for (const r of outcome.readings) {
      if (r.day !== prevDay) {
        prevDay = r.day;
        prev = -1;
      }
      expect(r.min).toBeGreaterThan(prev);
      prev = r.min;
    }
  });
});

describe('parseBuffer: 兼容各种输入格式', () => {
  it('CSV（日期,时间,血糖值）', () => {
    const csv = '日期,时间,血糖值mmol/L\n2025-03-20,01:45,6.6\n2025-03-20,01:50,6.7\n';
    const outcome = parseBuffer('glucose.csv', toArrayBuffer(csv));
    expect(outcome.readings).toEqual([
      { day: '2025-03-20', min: 105, v: 6.6 },
      { day: '2025-03-20', min: 110, v: 6.7 },
    ]);
  });

  it('日期与时间分成两列的 CSV：多天数据不会被压成一天', () => {
    // 回归用例：时间列只有「00:00」这种时分秒时，日期必须取本行的日期列，
    // 不能用上一行的日期兜底（曾经因此把多天数据合并到第一天）。
    const csv = [
      '日期,时间,血糖值mmol/L',
      '2025-01-01,00:00,5.6',
      '2025-01-01,00:05,5.7',
      '2025-01-02,00:00,6.1',
      '2025-01-02,12:00,7.2',
      '2025-01-03,00:00,5.9',
    ].join('\n');
    const outcome = parseBuffer('t.csv', toArrayBuffer(csv));
    expect(outcome.readings).toEqual([
      { day: '2025-01-01', min: 0, v: 5.6 },
      { day: '2025-01-01', min: 5, v: 5.7 },
      { day: '2025-01-02', min: 0, v: 6.1 },
      { day: '2025-01-02', min: 720, v: 7.2 },
      { day: '2025-01-03', min: 0, v: 5.9 },
    ]);
    expect(outcome.source.skipped).toBe(0);
  });

  it('日期列有合并/留空时，沿用上一行的日期（Excel 合并单元格）', () => {
    const csv = ['日期,时间,血糖值mmol/L', '2025-01-01,00:00,5.6', ',00:05,5.7', ',00:10,5.8'].join('\n');
    const outcome = parseBuffer('merged.csv', toArrayBuffer(csv));
    expect(outcome.readings.map((r) => `${r.day} ${r.min}`)).toEqual(['2025-01-01 0', '2025-01-01 5', '2025-01-01 10']);
  });

  it('自己导出的血糖 CSV 能原样导入（round-trip）', () => {
    const rows = [
      ['日期', '时间', '血糖值mmol/L'],
      ['2025-03-20', '00:00', 5.6],
      ['2025-03-20', '23:55', 6.1],
      ['2025-03-21', '00:00', 6.4],
    ];
    const csv = toCsv(rows);
    const outcome = parseBuffer('血糖数据-20250320.csv', toArrayBuffer('\uFEFF' + csv));
    expect(outcome.readings).toEqual([
      { day: '2025-03-20', min: 0, v: 5.6 },
      { day: '2025-03-20', min: 1435, v: 6.1 },
      { day: '2025-03-21', min: 0, v: 6.4 },
    ]);
  });

  it('mg/dL 会按中位数自动换算成 mmol/L', () => {
    const csv = '时刻,血糖值\n2025.3.20 10:00,120\n2025.3.20 10:05,126\n';
    const outcome = parseBuffer('mgdl.csv', toArrayBuffer(csv));
    expect(outcome.source.unit).toBe('mg/dL');
    expect(outcome.readings[0].v).toBeCloseTo(6.66, 2);
    expect(outcome.warnings.join()).toContain('mg/dL');
  });

  it('表头写明 mg/dL 时按 mg/dL 处理', () => {
    const csv = '时刻,血糖值mg/dL\n2025.3.20 10:00,90\n2025.3.20 10:05,108\n';
    const outcome = parseBuffer('mgdl2.csv', toArrayBuffer(csv));
    expect(outcome.source.unit).toBe('mg/dL');
    expect(outcome.readings[0].v).toBeCloseTo(5.0, 1);
  });

  it('Excel 日期序列号与真实日期单元格都能解析', () => {
    // 45736 = 2025-03-20
    const csv = '时刻,血糖值mmol/L\n45736.0729166667,6.6\n';
    const outcome = parseBuffer('serial.csv', toArrayBuffer(csv));
    expect(outcome.readings).toHaveLength(1);
    expect(outcome.readings[0].day).toBe('2025-03-20');
    expect(outcome.readings[0].min).toBeCloseTo(105, 1);
  });

  it('没有表头时按前两列解析', () => {
    const csv = '2025.3.20 10:00,6.1\n2025.3.20 10:05,6.2\n';
    const outcome = parseBuffer('noheader.csv', toArrayBuffer(csv));
    expect(outcome.readings).toHaveLength(2);
    expect(outcome.warnings.join()).toContain('没找到表头');
  });

  it('非数值行（LO/HI/空行）会被跳过并计数', () => {
    const csv = '时刻,血糖值mmol/L\n2025.3.20 10:00,6.1\n2025.3.20 10:05,LO\n,,,\n2025.3.20 10:10,6.3\n';
    const outcome = parseBuffer('lo.csv', toArrayBuffer(csv));
    expect(outcome.readings).toHaveLength(2);
    expect(outcome.source.skipped).toBeGreaterThan(0);
  });

  it('旧版标注 CSV 会被识别成标注（带日期列）', () => {
    const csv = '时间,活动描述,Y偏移量,日期(可选)\n12:10,吃饭15分钟,0.8,2025/3/17\n18:40,散步15min,-0.7,2025/3/17\n';
    const outcome = parseBuffer('annotations-20250317.csv', toArrayBuffer(csv));
    expect(outcome.kind).toBe('annotations');
    expect(outcome.annotations).toEqual([
      { day: '2025-03-17', min: 730, text: '吃饭15分钟', offset: 0.8 },
      { day: '2025-03-17', min: 1120, text: '散步15min', offset: -0.7 },
    ]);
  });

  it('没有日期列时用文件名里的日期兜底', () => {
    const csv = '时间,活动描述,Y偏移量\n09:30, 一根玉米肠,-3\n';
    const outcome = parseBuffer('annotations-20250316.csv', toArrayBuffer(csv));
    expect(outcome.annotations[0]).toEqual({ day: '2025-03-16', min: 570, text: '一根玉米肠', offset: -3 });
    expect(outcome.warnings.join()).toContain('2025-03-16');
  });

  it('时间列写成完整日期时间时也能取到日期', () => {
    const csv = '时间,活动描述\n2025.3.20 12:10,吃饭\n';
    const outcome = parseBuffer('ann2.csv', toArrayBuffer(csv));
    expect(outcome.annotations[0]).toMatchObject({ day: '2025-03-20', min: 730, text: '吃饭' });
  });

  it('本应用导出的 JSON 备份可以再导入', () => {
    const json = JSON.stringify({
      app: 'ottai-cgm-visualizer',
      version: 1,
      readings: { '2025-03-20': [105, 6.6, 110, 6.7] },
      annotations: [{ day: '2025-03-20', min: 750, text: '午饭', offset: 2 }],
    });
    const outcome = parseBuffer('backup.json', toArrayBuffer(json));
    expect(outcome.kind).toBe('workspace');
    expect(outcome.readings).toHaveLength(2);
    expect(outcome.annotations[0]).toMatchObject({ day: '2025-03-20', min: 750, text: '午饭', offset: 2 });
  });

  it('GBK 编码的 CSV 也能读', () => {
    // '时刻,血糖值mmol/L\n2025.3.20 10:00,6.1' 的 GBK 字节
    const bytes = new Uint8Array([
      0xca, 0xb1, 0xbf, 0xcc, 0x2c, 0xd1, 0xaa, 0xcc, 0xc7, 0xd6, 0xb5, 0x6d, 0x6d, 0x6f, 0x6c,
      0x2f, 0x4c, 0x0a, 0x32, 0x30, 0x32, 0x35, 0x2e, 0x33, 0x2e, 0x32, 0x30, 0x20, 0x31, 0x30,
      0x3a, 0x30, 0x30, 0x2c, 0x36, 0x2e, 0x31, 0x0a,
    ]);
    const outcome = parseBuffer('gbk.csv', bytes.buffer as ArrayBuffer);
    expect(outcome.readings).toHaveLength(1);
    expect(outcome.readings[0]).toEqual({ day: '2025-03-20', min: 600, v: 6.1 });
  });
});

describe('mergeReadings: 多次导入的去重与排序', () => {
  it('同一时刻新数据覆盖旧数据', () => {
    const first = [
      { day: '2025-03-20', min: 105, v: 6.6 },
      { day: '2025-03-20', min: 110, v: 6.7 },
    ];
    const second = [{ day: '2025-03-20', min: 105, v: 9.9 }];
    const { readings, duplicates } = mergeReadings(second, first);
    expect(duplicates).toBe(1);
    expect(readings).toHaveLength(2);
    expect(readings[0].v).toBe(9.9);
  });

  it('不同日期会按时间升序合并', () => {
    const { readings } = mergeReadings(
      [{ day: '2025-03-21', min: 10, v: 5 }],
      [{ day: '2025-03-20', min: 100, v: 6 }],
    );
    expect(readings.map((r) => r.day)).toEqual(['2025-03-20', '2025-03-21']);
  });
});
