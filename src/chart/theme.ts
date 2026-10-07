/**
 * 配色：与 ECharts 主题、CSS 变量保持一致
 */
export interface Palette {
  mode: 'light' | 'dark';
  pageBg: string;
  cardBg: string;
  text: string;
  muted: string;
  grid: string;
  axisLine: string;
  normal: string;
  high: string;
  low: string;
  areaFrom: string;
  areaTo: string;
  band: string;
  annotation: string;
  annotationBg: string;
  peak: string;
  tooltipBg: string;
  tooltipBorder: string;
}

export const LIGHT: Palette = {
  mode: 'light',
  pageBg: '#f4f6fb',
  cardBg: '#ffffff',
  text: '#1f2733',
  muted: '#8a94a6',
  grid: '#eef1f7',
  axisLine: '#dfe4ee',
  normal: '#4a86e8',
  high: '#f39c12',
  low: '#e2564d',
  areaFrom: 'rgba(74,134,232,0.20)',
  areaTo: 'rgba(74,134,232,0.01)',
  band: 'rgba(74,134,232,0.05)',
  annotation: '#e74c3c',
  annotationBg: 'rgba(255,255,255,0.92)',
  peak: '#9c27b0',
  tooltipBg: 'rgba(255,255,255,0.97)',
  tooltipBorder: '#e3e8f0',
};

export const DARK: Palette = {
  mode: 'dark',
  pageBg: '#0b0f17',
  cardBg: '#121826',
  text: '#e7ecf5',
  muted: '#8b98ad',
  grid: '#1d2534',
  axisLine: '#28313f',
  normal: '#5b9dff',
  high: '#f5b041',
  low: '#ef6b60',
  areaFrom: 'rgba(91,157,255,0.26)',
  areaTo: 'rgba(91,157,255,0.01)',
  band: 'rgba(91,157,255,0.06)',
  annotation: '#ff7a6b',
  annotationBg: 'rgba(18,24,38,0.92)',
  peak: '#c084fc',
  tooltipBg: 'rgba(18,24,38,0.97)',
  tooltipBorder: '#28313f',
};

export function paletteFor(mode: 'light' | 'dark'): Palette {
  return mode === 'dark' ? DARK : LIGHT;
}

export const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
