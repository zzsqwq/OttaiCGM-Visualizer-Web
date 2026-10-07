import { describe, expect, it } from 'vitest';
import { annotationsToCsv, workspaceToJson } from '../src/io/exporters';
import { parseBuffer } from '../src/core/parser';
import type { Annotation, Dataset } from '../src/core/types';

const ann = (min: number, text: string, offset: number, day = '2025-03-17'): Annotation => ({
  id: `a${min}`,
  day,
  min,
  text,
  offset,
});

function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('标注 CSV：与原 Python 脚本的格式互通', () => {
  const annotations = [
    ann(730, '吃饭15分钟，紫米+香干炒肉+番茄炒蛋', 0.8),
    ann(1120, '散步15min', -0.7),
    ann(1430, '两包干脆面+两根玉米肠', 0.3, '2025-03-18'),
  ];

  it('导出格式与 README 里描述的一致', () => {
    const csv = annotationsToCsv(annotations);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('时间,活动描述,Y偏移量,日期(可选)');
    expect(lines[1]).toBe('12:10,吃饭15分钟，紫米+香干炒肉+番茄炒蛋,0.8,2025/03/17');
    expect(lines[2]).toBe('18:40,散步15min,-0.7,2025/03/17');
    expect(lines[3]).toBe('23:50,两包干脆面+两根玉米肠,0.3,2025/03/18');
  });

  it('导出的 CSV 可以再被导入（round-trip）', () => {
    const csv = annotationsToCsv(annotations);
    const outcome = parseBuffer('annotations-20250317.csv', toArrayBuffer(csv));
    expect(outcome.kind).toBe('annotations');
    expect(outcome.annotations).toEqual([
      { day: '2025-03-17', min: 730, text: '吃饭15分钟，紫米+香干炒肉+番茄炒蛋', offset: 0.8 },
      { day: '2025-03-17', min: 1120, text: '散步15min', offset: -0.7 },
      { day: '2025-03-18', min: 1430, text: '两包干脆面+两根玉米肠', offset: 0.3 },
    ]);
  });

  it('文本里带逗号、引号也不会串列', () => {
    const tricky = [ann(600, '早餐：燕麦粥, 鸡蛋"两个"', 0.5)];
    const csv = annotationsToCsv(tricky);
    const outcome = parseBuffer('annotations-20250317.csv', toArrayBuffer(csv));
    expect(outcome.annotations[0].text).toBe('早餐：燕麦粥, 鸡蛋"两个"');
    expect(outcome.annotations[0].offset).toBe(0.5);
  });

  it('不带日期列时导出为三列', () => {
    const csv = annotationsToCsv(annotations, false).replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(csv[0]).toBe('时间,活动描述,Y偏移量');
    expect(csv[1]).toBe('12:10,吃饭15分钟，紫米+香干炒肉+番茄炒蛋,0.8');
  });
});

describe('工作区 JSON 备份：完整往返', () => {
  const dataset: Dataset = {
    readings: [
      { day: '2025-03-17', min: 0, v: 5.6 },
      { day: '2025-03-17', min: 5, v: 5.8 },
      { day: '2025-03-18', min: 0, v: 6.1 },
    ],
    days: ['2025-03-17', '2025-03-18'],
    sources: [],
    convertedFromMgDl: false,
    loadedAt: 0,
  };

  it('导出的 JSON 能被 parseBuffer 还原', () => {
    const json = workspaceToJson(dataset, [ann(730, '午饭', 1.5)], { showPeaks: true });
    const outcome = parseBuffer('backup.json', toArrayBuffer(json));
    expect(outcome.kind).toBe('workspace');
    expect(outcome.readings).toEqual(dataset.readings);
    expect(outcome.annotations).toEqual([{ day: '2025-03-17', min: 730, text: '午饭', offset: 1.5 }]);
    expect(outcome.settings).toEqual({ showPeaks: true });
  });

  it('没有数据时也能导出（空备份）', () => {
    const json = workspaceToJson(null, []);
    const outcome = parseBuffer('backup.json', toArrayBuffer(json));
    expect(outcome.readings).toEqual([]);
    expect(outcome.annotations).toEqual([]);
  });
});
