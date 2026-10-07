/**
 * 导入 / 导出
 * - 标注 CSV：与原 Python 脚本（visualizer.py）的格式互通
 * - 工作区 JSON：完整备份（血糖 + 标注 + 设置），下次直接接着用
 * - 图片 PNG：把图表和标注一起画到一张图上，方便分享
 */
import { toCsvWithBom, toCsv } from '../core/csv';
import { formatHM, formatDayCn, weekdayCn } from '../core/time';
import type { Annotation, Reading, Dataset } from '../core/types';
import type { Stats } from '../core/stats';
import { FONT_FAMILY, type Palette } from '../chart/theme';

export function annotationsToCsv(annotations: Annotation[], withDay = true): string {
  const rows: (string | number)[][] = [withDay ? ['时间', '活动描述', 'Y偏移量', '日期(可选)'] : ['时间', '活动描述', 'Y偏移量']];
  for (const a of [...annotations].sort((x, y) => (x.day === y.day ? x.min - y.min : x.day < y.day ? -1 : 1))) {
    const row: (string | number)[] = [formatHM(a.min), a.text, a.offset];
    if (withDay) row.push(a.day.replace(/-/g, '/'));
    rows.push(row);
  }
  return toCsvWithBom(rows);
}

export interface WorkspaceExport {
  app: 'ottai-cgm-visualizer';
  version: 1;
  exportedAt: string;
  readings: Record<string, number[]>;
  annotations: { day: string; min: number; text: string; offset: number; sample?: boolean; source?: string }[];
  sources?: Dataset['sources'];
  settings?: Record<string, unknown>;
}

export function workspaceToJson(
  dataset: Dataset | null,
  annotations: Annotation[],
  settings?: Record<string, unknown>,
): string {
  const readings: Record<string, number[]> = {};
  if (dataset) {
    for (const r of dataset.readings) {
      const arr = readings[r.day] ?? (readings[r.day] = []);
      arr.push(Math.round(r.min * 100) / 100, r.v);
    }
  }
  const payload: WorkspaceExport = {
    app: 'ottai-cgm-visualizer',
    version: 1,
    exportedAt: new Date().toISOString(),
    readings,
    sources: dataset?.sources ?? [],
    annotations: annotations.map((a) => ({
      day: a.day,
      min: Math.round(a.min * 100) / 100,
      text: a.text,
      offset: a.offset,
      ...(a.sample ? { sample: true } : {}),
      ...(a.source ? { source: a.source } : {}),
    })),
    settings,
  };
  return JSON.stringify(payload);
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function csvRowsForReadings(readings: Reading[]): string {
  const rows: (string | number)[][] = [['日期', '时间', '血糖值mmol/L']];
  for (const r of readings) rows.push([r.day, formatHM(r.min), r.v]);
  return toCsv(rows);
}

export interface PngExportOptions {
  chartDataUrl: string;
  pixelRatio: number;
  palette: Palette;
  day: string;
  stats: Stats;
  labels: {
    text: string;
    time: string;
    labelX: number;
    labelY: number;
    w: number;
    h: number;
    anchorX: number;
    anchorY: number;
    startX: number;
    startY: number;
    selected: boolean;
  }[];
  annotationCount: number;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 把 ECharts 画布 + 标注 + 标题合成一张 PNG，返回 Blob */
export async function composePng(opts: PngExportOptions): Promise<Blob> {
  const { chartDataUrl, pixelRatio, palette, day, stats, labels } = opts;
  const img = new Image();
  img.src = chartDataUrl;
  await img.decode();

  const scale = pixelRatio;
  const headH = 74 * scale;
  const footH = 34 * scale;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height + headH + footH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');

  ctx.fillStyle = palette.cardBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ---- 标题区
  const pad = 28 * scale;
  ctx.fillStyle = palette.text;
  ctx.font = `600 ${20 * scale}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`每日血糖曲线 · ${formatDayCn(day)} ${weekdayCn(day)}`, pad, 34 * scale);

  ctx.font = `${12.5 * scale}px ${FONT_FAMILY}`;
  ctx.fillStyle = palette.muted;
  const summary = [
    `平均 ${stats.mean.toFixed(1)} mmol/L`,
    `TIR ${stats.tir.toFixed(0)}%`,
    `最高 ${stats.max.toFixed(1)}`,
    `最低 ${stats.min.toFixed(1)}`,
    `CV ${stats.cv.toFixed(0)}%`,
    `标注 ${opts.annotationCount} 条`,
  ].join('   ·   ');
  ctx.fillText(summary, pad, 56 * scale);

  // ---- 图表
  ctx.drawImage(img, 0, headH);

  // ---- 标注
  const annColor = palette.annotation;
  for (const l of labels) {
    ctx.save();
    // 标注坐标是「图表 CSS 像素」，缩放到导出的像素比并下移标题高度
    ctx.translate(0, headH);
    ctx.scale(scale, scale);

    const cx = l.labelX;
    const cy = l.labelY;
    const w = l.w;
    const h = l.h;

    // 引线（二次贝塞尔 + 箭头）
    ctx.strokeStyle = annColor;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(l.startX, l.startY);
    const mx = (l.startX + l.anchorX) / 2;
    const my = (l.startY + l.anchorY) / 2;
    const dx = l.anchorX - l.startX;
    const dy = l.anchorY - l.startY;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = dist * 0.15 * (l.anchorY >= l.labelY ? 1 : -1);
    ctx.quadraticCurveTo(mx + (dy / dist) * bow, my - (dx / dist) * bow, l.anchorX, l.anchorY);
    ctx.stroke();

    const ang = Math.atan2(l.anchorY - my, l.anchorX - mx);
    const size = 5.5;
    ctx.beginPath();
    ctx.moveTo(l.anchorX, l.anchorY);
    ctx.lineTo(l.anchorX - size * Math.cos(ang - 0.4), l.anchorY - size * Math.sin(ang - 0.4));
    ctx.lineTo(l.anchorX - size * Math.cos(ang + 0.4), l.anchorY - size * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = annColor;
    ctx.fill();

    // 标签
    ctx.font = `${12}px ${FONT_FAMILY}`;
    const boxX = cx - w / 2;
    const boxY = cy - h / 2;
    roundRect(ctx, boxX, boxY, w, h, 7);
    ctx.fillStyle = palette.annotationBg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(231,76,60,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = annColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(`${l.time} ${l.text}`, boxX + 8, cy + 0.5);
    ctx.restore();
  }

  // ---- 页脚
  ctx.fillStyle = palette.muted;
  ctx.font = `${10.5 * scale}px ${FONT_FAMILY}`;
  ctx.fillText(`血糖可视化 · 目标范围 ${stats.target.low}–${stats.target.high} mmol/L · 浏览器本地绘制`, pad, canvas.height - 13 * scale);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('导出失败'))), 'image/png');
  });
}

export { toCsv };
