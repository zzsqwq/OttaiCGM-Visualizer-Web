/**
 * 每日血糖曲线图（ECharts）
 *
 * 图表只负责「曲线 + 参考范围 + 峰值」，活动标注由 DOM/SVG 叠加层绘制
 * （见 overlay.ts），这样标注可以自由拖动、直接编辑文字。
 */
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts, EChartsOption } from 'echarts';
import type { Annotation, Reading, TargetRange } from '../core/types';
import type { Peak } from '../core/types';
import { buildChartData, interpolateAt, valueAt } from '../core/series';
import { formatHM } from '../core/time';
import { FONT_FAMILY, type Palette } from './theme';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export interface DayChartContext {
  day: string;
  readings: Reading[];
  annotations: Annotation[];
  peaks: Peak[];
  target: TargetRange;
  palette: Palette;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** 计算 y 轴范围：留出上下空间，并保证参考范围可见 */
export function yRange(readings: Reading[], annotations: Annotation[]): { min: number; max: number } {
  let dataMax = 0;
  let dataMin = Infinity;
  for (const r of readings) {
    if (r.v > dataMax) dataMax = r.v;
    if (r.v < dataMin) dataMin = r.v;
  }
  let annMax = 0;
  for (const a of annotations) {
    const v = valueAt(readings, a.min);
    if (v == null) continue;
    annMax = Math.max(annMax, v + a.offset);
  }
  if (!readings.length) return { min: 0, max: 12 };
  // 下界只看数据：保证下限参考线可见即可，不让「向下的标注」把坐标轴拉得很长
  const min = Math.max(0, Math.min(3.0, dataMin - 0.6));
  // 上界要留出标注的位置
  const max = Math.max(dataMax + 1.4, annMax + 0.9, 8.4);
  return { min: Math.floor(min * 2) / 2, max: Math.ceil(max * 2) / 2 };
}

export function buildOption(ctx: DayChartContext): EChartsOption {
  const { readings, annotations, peaks, target, palette } = ctx;
  const data = buildChartData(readings, target);
  const range = yRange(readings, annotations);

  const peakData = peaks
    .filter((p) => p.v > target.high)
    .map((p) => ({
      value: [p.min, p.v],
      label: { show: true, formatter: `${formatHM(p.min)} ${p.v.toFixed(1)}`, position: 'top' as const },
    }));

  const annotationMarkers = annotations.map((a) => {
    const v = valueAt(readings, a.min);
    return { value: [a.min, v ?? 0], name: a.text, id: a.id };
  });

  return {
    animation: true,
    animationDuration: 260,
    animationEasing: 'cubicOut',
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_FAMILY },
    grid: { left: 54, right: 28, top: 26, bottom: 54 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: palette.text, fontSize: 12, fontFamily: FONT_FAMILY },
      extraCssText: 'border-radius:10px;box-shadow:0 6px 24px rgba(15,25,45,0.12);',
      axisPointer: {
        type: 'line',
        lineStyle: { color: palette.axisLine, width: 1, type: 'dashed' },
        label: { show: false },
      },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const first = arr[0] as { axisValue?: number | string } | undefined;
        const rawMin = typeof first?.axisValue === 'number' ? first.axisValue : Number(first?.axisValue);
        if (!Number.isFinite(rawMin)) return '';
        const v = interpolateAt(readings, rawMin);
        if (v == null) return '';
        const near = annotations.filter((a) => Math.abs(a.min - rawMin) <= 8);
        const color = v > target.high ? palette.high : v < target.low ? palette.low : palette.normal;
        const lines = [
          `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(formatHM(rawMin))}</div>`,
          `<div style="color:${color};font-weight:600;font-size:14px">${v.toFixed(1)} <span style="font-size:11px;opacity:.7">mmol/L</span></div>`,
        ];
        if (near.length) {
          lines.push(
            `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${palette.grid}">` +
              near
                .map(
                  (a) =>
                    `<div style="color:${palette.annotation};font-size:12px">${escapeHtml(formatHM(a.min))} ${escapeHtml(a.text)}</div>`,
                )
                .join('') +
              '</div>',
          );
        }
        return lines.join('');
      },
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: 1440,
      interval: 120,
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        formatter: (value: number) => formatHM(value),
      },
      splitLine: { lineStyle: { color: palette.grid, type: 'dashed' } },
      axisPointer: { label: { show: false } },
    },
    yAxis: {
      type: 'value',
      min: range.min,
      max: range.max,
      splitNumber: 5,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, fontSize: 11, formatter: (v: number) => v.toFixed(1) },
      splitLine: { lineStyle: { color: palette.grid, type: 'dashed' } },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true },
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        height: 20,
        bottom: 8,
        borderColor: 'transparent',
        backgroundColor: palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(15,25,45,0.03)',
        fillerColor: palette.mode === 'dark' ? 'rgba(91,157,255,0.16)' : 'rgba(74,134,232,0.12)',
        handleStyle: { color: palette.normal, borderColor: palette.normal },
        moveHandleStyle: { color: palette.normal, opacity: 0.35 },
        dataBackground: {
          lineStyle: { color: palette.muted, opacity: 0.5 },
          areaStyle: { color: palette.muted, opacity: 0.15 },
        },
        selectedDataBackground: {
          lineStyle: { color: palette.normal, opacity: 0.8 },
          areaStyle: { color: palette.normal, opacity: 0.2 },
        },
        labelFormatter: (value: number) => formatHM(value),
        textStyle: { color: palette.muted, fontSize: 10 },
      },
    ],
    visualMap: {
      show: false,
      seriesIndex: 0,
      dimension: 1,
      pieces: [
        { lt: target.low, color: palette.low },
        { gte: target.low, lte: target.high, color: palette.normal },
        { gt: target.high, color: palette.high },
      ],
      outOfRange: { color: palette.muted },
    },
    series: [
      {
        id: 'glucose',
        name: '血糖',
        type: 'line',
        data,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 8,
        smooth: false,
        connectNulls: false,
        sampling: 'lttb',
        lineStyle: { width: 2.4, cap: 'round', join: 'round' },
        itemStyle: { color: palette.normal },
        areaStyle: {
          opacity: 1,
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: palette.areaFrom },
            { offset: 1, color: palette.areaTo },
          ]),
        },
        emphasis: { scale: false, itemStyle: { color: palette.text } },
        markArea: {
          silent: true,
          itemStyle: { color: palette.band },
          data: [[{ yAxis: target.low }, { yAxis: target.high }]],
        },
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          data: [
            {
              yAxis: target.high,
              lineStyle: { color: palette.high, type: 'dashed', width: 1.2, opacity: 0.9 },
              label: {
                formatter: `${target.high} 上限`,
                position: 'insideEndTop',
                color: palette.high,
                fontSize: 11,
                distance: 4,
              },
            },
            {
              yAxis: target.low,
              lineStyle: { color: palette.muted, type: 'dashed', width: 1.2, opacity: 0.8 },
              label: {
                formatter: `${target.low} 下限`,
                position: 'insideEndBottom',
                color: palette.muted,
                fontSize: 11,
                distance: 4,
              },
            },
          ],
        },
      },
      {
        id: 'peaks',
        name: '峰值',
        type: 'scatter',
        data: peakData,
        symbolSize: 7,
        itemStyle: { color: palette.peak, borderColor: palette.cardBg, borderWidth: 1.5 },
        label: {
          color: palette.peak,
          fontSize: 11,
          fontWeight: 600,
          formatter: (p: { value: number[] }) => `${formatHM(p.value[0])} ${p.value[1].toFixed(1)}`,
        },
        z: 6,
        silent: true,
      },
      {
        id: 'annotation-anchors',
        name: '标注锚点',
        type: 'scatter',
        data: annotationMarkers,
        symbolSize: 6,
        itemStyle: { color: palette.annotation, opacity: 0.85, borderColor: palette.cardBg, borderWidth: 1 },
        z: 5,
        silent: true,
        tooltip: { show: false },
      },
    ],
  } as EChartsOption;
}

/** ECharts 实例包装 */
export class DayChart {
  readonly chart: ECharts;
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    this.chart = echarts.init(el, undefined, { renderer: 'canvas', useDirtyRect: true });
  }

  get dom(): HTMLElement {
    return this.el;
  }

  setOption(ctx: DayChartContext, keepZoom = true): void {
    const option = buildOption(ctx);
    if (!keepZoom) {
      (option.dataZoom as { start?: number; end?: number }[]).forEach((dz) => {
        dz.start = 0;
        dz.end = 100;
      });
    } else {
      // 不传 start/end，保持用户当前的缩放窗口
      (option.dataZoom as { start?: number; end?: number }[]).forEach((dz) => {
        delete dz.start;
        delete dz.end;
      });
    }
    this.chart.setOption(option, { notMerge: false, lazyUpdate: false, replaceMerge: ['series', 'visualMap'] });
  }

  resize(): void {
    this.chart.resize();
  }

  dispose(): void {
    this.chart.dispose();
  }

  /** 分钟 -> 画布 x 像素 */
  xToPixel(min: number): number {
    return this.chart.convertToPixel({ xAxisIndex: 0 }, min) as number;
  }

  /** 血糖值 -> 画布 y 像素 */
  yToPixel(value: number): number {
    return this.chart.convertToPixel({ yAxisIndex: 0 }, value) as number;
  }

  /** 画布 x 像素 -> 分钟 */
  pixelToMin(px: number): number {
    return this.chart.convertFromPixel({ xAxisIndex: 0 }, px) as number;
  }

  /** 画布 y 像素 -> 血糖值 */
  pixelToValue(py: number): number {
    return this.chart.convertFromPixel({ yAxisIndex: 0 }, py) as number;
  }

  /** 当前缩放窗口（分钟） */
  zoomWindow(): { start: number; end: number } {
    const opt = this.chart.getOption() as {
      dataZoom?: { start?: number; end?: number; startValue?: number; endValue?: number }[];
    };
    const dz = opt.dataZoom?.[0];
    if (!dz) return { start: 0, end: 1440 };
    const start = typeof dz.startValue === 'number' ? dz.startValue : ((dz.start ?? 0) / 100) * 1440;
    const end = typeof dz.endValue === 'number' ? dz.endValue : ((dz.end ?? 100) / 100) * 1440;
    return { start, end };
  }

  resetZoom(): void {
    this.chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  }

  on(event: string, handler: (params: unknown) => void): void {
    this.chart.on(event, handler as (p: unknown) => void);
  }

  getDataURL(pixelRatio = 2, background?: string): string {
    return this.chart.getDataURL({ type: 'png', pixelRatio, backgroundColor: background });
  }

  /** 导出图片时临时隐藏底部缩放条（静态图里不需要） */
  async captureForExport(pixelRatio = 2, background?: string): Promise<string> {
    this.chart.setOption({ dataZoom: [{}, { show: false }] });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const url = this.getDataURL(pixelRatio, background);
    this.chart.setOption({ dataZoom: [{}, { show: true }] });
    return url;
  }
}

export { echarts };
