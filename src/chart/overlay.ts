/**
 * 标注叠加层
 *
 * 标注不用 canvas 画，而是 DOM（文字）+ SVG（引线）叠加在图表上方，
 * 这样可以直接拖动、双击改字、一键删除，交互和普通网页元素一样自然。
 * 位置通过 ECharts 的 convertToPixel 换算，缩放/窗口变化时重新计算。
 */
import type { Annotation, Reading } from '../core/types';
import { valueAt } from '../core/series';
import { formatHM } from '../core/time';
import type { DayChart } from './dayChart';

export interface OverlayCallbacks {
  onSelect: (id: string | null) => void;
  /** 交互结束（拖动松手 / 编辑完成）时提交 */
  onCommit: (id: string, patch: { offset?: number; min?: number; text?: string }) => void;
  onDelete: (id: string) => void;
  onEditStart: (id: string | null) => void;
}

interface Entry {
  id: string;
  label: HTMLElement;
  anchor: HTMLElement;
  path: SVGPathElement;
  editing: boolean;
  /** 缓存的标签尺寸：避免每帧都读 offsetWidth/offsetHeight（会触发布局） */
  w: number;
  h: number;
  sizeDirty: boolean;
}

const LABEL_PAD = 6;
const EDGE_PAD = 10;

function rectLineIntersection(
  cx: number,
  cy: number,
  w: number,
  h: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = w / 2;
  const halfH = h / 2;
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(scaleX, scaleY);
  return { x: cx + dx * t, y: cy + dy * t };
}

export class AnnotationOverlay {
  private root: HTMLElement;
  private svg: SVGSVGElement;
  private layer: HTMLElement;
  private chart: DayChart;
  private cb: OverlayCallbacks;
  private entries = new Map<string, Entry>();
  private annotations: Annotation[] = [];
  private readings: Reading[] = [];
  private selectedId: string | null = null;
  private lastW = 0;
  private lastH = 0;
  private dragState: {
    id: string;
    mode: 'label' | 'anchor';
    startX: number;
    startY: number;
    startOffset: number;
    startMin: number;
    moved: boolean;
  } | null = null;

  constructor(
    root: HTMLElement,
    svg: SVGSVGElement,
    layer: HTMLElement,
    chart: DayChart,
    cb: OverlayCallbacks,
  ) {
    this.root = root;
    this.svg = svg;
    this.layer = layer;
    this.chart = chart;
    this.cb = cb;
    this.ensureDefs();
  }

  private ensureDefs(): void {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <marker id="ann-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ann-color)"></path>
      </marker>
      <marker id="ann-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ann-color-sel)"></path>
      </marker>`;
    this.svg.appendChild(defs);
  }

  setData(annotations: Annotation[], readings: Reading[], selectedId: string | null): void {
    // 存一份克隆：拖动过程中直接改这份数据做预览，松手才写回 store
    this.annotations = annotations.map((a) => ({ ...a }));
    this.readings = readings;
    this.selectedId = selectedId;

    const seen = new Set<string>();
    for (const ann of this.annotations) {
      seen.add(ann.id);
      let entry = this.entries.get(ann.id);
      if (!entry) entry = this.createEntry(ann);
      this.updateEntryContent(entry, ann);
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.label.remove();
        entry.anchor.remove();
        entry.path.remove();
        this.entries.delete(id);
      }
    }
    this.position();
  }

  /** 拖动中的本地预览（不触发 store，避免整页重绘） */
  private preview(id: string, patch: { offset?: number; min?: number }): void {
    const ann = this.annotations.find((a) => a.id === id);
    if (!ann) return;
    if (patch.offset !== undefined) ann.offset = patch.offset;
    if (patch.min !== undefined) {
      ann.min = patch.min;
      const entry = this.entries.get(id);
      const timeEl = entry?.label.querySelector('.ann-time');
      if (timeEl) timeEl.textContent = formatHM(ann.min);
    }
    this.position();
  }

  private createEntry(ann: Annotation): Entry {
    const label = document.createElement('div');
    label.className = 'ann-label';
    label.dataset.id = ann.id;
    label.tabIndex = 0;
    label.setAttribute('role', 'button');

    const time = document.createElement('span');
    time.className = 'ann-time';
    const text = document.createElement('span');
    text.className = 'ann-text';
    label.append(time, text);

    const del = document.createElement('button');
    del.className = 'ann-del';
    del.type = 'button';
    del.title = '删除标注';
    del.setAttribute('aria-label', '删除标注');
    del.textContent = '×';
    label.appendChild(del);

    const anchor = document.createElement('div');
    anchor.className = 'ann-anchor';
    anchor.dataset.id = ann.id;
    anchor.title = '左右拖动可调整时间';

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'ann-path');
    path.setAttribute('marker-end', 'url(#ann-arrow)');

    this.layer.appendChild(label);
    this.layer.appendChild(anchor);
    this.svg.appendChild(path);

    const entry: Entry = { id: ann.id, label, anchor, path, editing: false, w: 0, h: 0, sizeDirty: true };

    label.addEventListener('pointerdown', (e) => this.onPointerDown(e, ann.id, 'label'));
    anchor.addEventListener('pointerdown', (e) => this.onPointerDown(e, ann.id, 'anchor'));
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startEditing(ann.id);
    });
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onDelete(ann.id);
    });
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.startEditing(ann.id);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.cb.onDelete(ann.id);
      }
    });

    this.entries.set(ann.id, entry);
    return entry;
  }

  private updateEntryContent(entry: Entry, ann: Annotation): void {
    if (entry.editing) return;
    const timeEl = entry.label.querySelector('.ann-time') as HTMLElement | null;
    const textEl = entry.label.querySelector('.ann-text') as HTMLElement | null;
    if (timeEl) timeEl.textContent = formatHM(ann.min);
    if (textEl && textEl.textContent !== (ann.text || '（空）')) {
      textEl.textContent = ann.text || '（空）';
      entry.sizeDirty = true; // 文字变了要重新量尺寸
    }
    entry.label.classList.toggle('is-selected', ann.id === this.selectedId);
    entry.label.setAttribute('aria-label', `${formatHM(ann.min)} ${ann.text}`);
    entry.path.classList.toggle('is-selected', ann.id === this.selectedId);
    entry.anchor.classList.toggle('is-selected', ann.id === this.selectedId);
  }

  /** 进入文字编辑状态 */
  startEditing(id: string): void {
    const entry = this.entries.get(id);
    const ann = this.annotations.find((a) => a.id === id);
    if (!entry || !ann || entry.editing) return;
    entry.editing = true;
    this.cb.onEditStart(id);
    entry.label.classList.add('is-editing');

    const input = document.createElement('input');
    input.className = 'ann-input';
    input.value = ann.text;
    input.placeholder = '吃了什么 / 做了什么 / 感受';
    const timeEl = entry.label.querySelector('.ann-time') as HTMLElement;
    const textEl = entry.label.querySelector('.ann-text') as HTMLElement;
    textEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      const span = document.createElement('span');
      span.className = 'ann-text';
      span.textContent = value || ann.text || '（空）';
      input.replaceWith(span);
      entry.editing = false;
      entry.sizeDirty = true;
      entry.label.classList.remove('is-editing');
      this.cb.onEditStart(null);
      timeEl.textContent = formatHM(ann.min);
      if (commit) this.cb.onCommit(id, { text: value });
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  private onPointerDown(e: PointerEvent, id: string, mode: 'label' | 'anchor'): void {
    if (e.button !== 0) return;
    const entry = this.entries.get(id);
    const ann = this.annotations.find((a) => a.id === id);
    if (!entry || !ann || entry.editing) return;
    e.preventDefault();
    e.stopPropagation();
    this.cb.onSelect(id);

    this.dragState = {
      id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startOffset: ann.offset,
      startMin: ann.min,
      moved: false,
    };
    entry.label.classList.add('is-dragging');
    entry.label.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => this.onPointerMove(ev);
    const onUp = (ev: PointerEvent) => {
      entry.label.releasePointerCapture(ev.pointerId);
      entry.label.removeEventListener('pointermove', onMove);
      entry.label.removeEventListener('pointerup', onUp);
      entry.label.removeEventListener('pointercancel', onUp);
      this.onPointerUp();
    };
    entry.label.addEventListener('pointermove', onMove);
    entry.label.addEventListener('pointerup', onUp);
    entry.label.addEventListener('pointercancel', onUp);
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.dragState;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;

    if (drag.mode === 'label') {
      const startValue = valueAt(this.readings, drag.startMin);
      if (startValue == null) return;
      const startPixel = this.chart.yToPixel(startValue + drag.startOffset);
      const nextPixel = startPixel + dy;
      const nextValue = this.chart.pixelToValue(nextPixel);
      const offset = Math.round((nextValue - startValue) * 10) / 10;
      this.preview(drag.id, { offset });
    } else {
      const rect = this.root.getBoundingClientRect();
      const min = this.chart.pixelToMin(e.clientX - rect.left);
      this.preview(drag.id, { min: Math.max(0, Math.min(1440, Math.round(min))) });
    }
  }

  private onPointerUp(): void {
    const drag = this.dragState;
    this.dragState = null;
    if (!drag) return;
    const entry = this.entries.get(drag.id);
    entry?.label.classList.remove('is-dragging');
    const ann = this.annotations.find((a) => a.id === drag.id);
    if (!ann) return;
    if (drag.moved) {
      this.cb.onCommit(drag.id, { offset: ann.offset, min: ann.min });
    }
  }

  /** 重新计算所有标注的位置（图表渲染完成 / 缩放 / 尺寸变化时调用） */
  position(): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (!width || !height) return;
    // 只在画布尺寸真的变了才动 SVG 属性，否则每帧写一次会触发多余的重排
    if (width !== this.lastW || height !== this.lastH) {
      this.lastW = width;
      this.lastH = height;
      this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.svg.setAttribute('width', String(width));
      this.svg.setAttribute('height', String(height));
    }

    interface Placement {
      entry: Entry;
      ann: Annotation;
      anchorX: number;
      anchorY: number;
      desiredY: number;
      w: number;
      h: number;
    }

    const placements: Placement[] = [];
    const { start, end } = this.chart.zoomWindow();
    for (const ann of this.annotations) {
      const entry = this.entries.get(ann.id);
      if (!entry) continue;
      const base = valueAt(this.readings, ann.min);
      // 标签、锚点和引线共用当前可见时间范围，导出也复用这份布局。
      if (base == null || ann.min < start || ann.min > end) {
        entry.label.style.display = 'none';
        entry.anchor.style.display = 'none';
        entry.path.style.display = 'none';
        continue;
      }
      entry.label.style.display = '';
      entry.anchor.style.display = '';
      entry.path.style.display = '';
      const anchorX = this.chart.xToPixel(ann.min);
      const anchorY = this.chart.yToPixel(base);
      const desiredY = this.chart.yToPixel(base + ann.offset);
      // 尺寸只在内容变化后重新量一次，之后走缓存
      if (entry.sizeDirty || !entry.w) {
        entry.w = entry.label.offsetWidth || 80;
        entry.h = entry.label.offsetHeight || 24;
        entry.sizeDirty = false;
      }
      placements.push({ entry, ann, anchorX, anchorY, desiredY, w: entry.w, h: entry.h });
    }

    placements.sort((a, b) => a.anchorX - b.anchorX);

    const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];

    for (const p of placements) {
      const halfW = p.w / 2 + LABEL_PAD;
      const halfH = p.h / 2 + LABEL_PAD;
      let x = Math.max(halfW + EDGE_PAD, Math.min(width - halfW - EDGE_PAD, p.anchorX));
      const dir = p.ann.offset >= 0 ? -1 : 1;
      const gap = p.h + 8;

      const candidates: number[] = [0];
      for (let k = 1; k <= 10; k++) {
        candidates.push(dir * k * gap);
        candidates.push(-dir * k * gap);
      }

      let y = p.desiredY;
      for (const offset of candidates) {
        const cy = Math.max(halfH + 4, Math.min(height - halfH - 4, p.desiredY + offset));
        const box = { x1: x - halfW, y1: cy - halfH, x2: x + halfW, y2: cy + halfH };
        const hit = placed.some((q) => box.x1 < q.x2 && box.x2 > q.x1 && box.y1 < q.y2 && box.y2 > q.y1);
        if (!hit) {
          y = cy;
          break;
        }
        y = cy;
      }

      placed.push({ x1: x - halfW, y1: y - halfH, x2: x + halfW, y2: y + halfH });
      p.entry.label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      p.entry.anchor.style.transform = `translate3d(${p.anchorX}px, ${p.anchorY}px, 0) translate(-50%, -50%)`;

      // 引线：从标签边缘指向数据点，带一点弧度（对应原脚本里的 arc3,rad=0.15）
      const start = rectLineIntersection(x, y, p.w, p.h, p.anchorX, p.anchorY);
      const mx = (start.x + p.anchorX) / 2;
      const my = (start.y + p.anchorY) / 2;
      const dx = p.anchorX - start.x;
      const dy = p.anchorY - start.y;
      const dist = Math.hypot(dx, dy) || 1;
      const bow = dist * 0.15 * (p.anchorY >= y ? 1 : -1);
      const cx = mx + (dy / dist) * bow;
      const cy = my - (dx / dist) * bow;
      p.entry.path.setAttribute('d', `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${p.anchorX.toFixed(1)} ${p.anchorY.toFixed(1)}`);
      p.entry.path.dataset.startX = String(start.x);
      p.entry.path.dataset.startY = String(start.y);
    }
  }

  /** 已放置标签的布局信息，导出图片时复用（保证图片和屏幕一致） */
  snapshotLayout(): {
    id: string;
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
  }[] {
    const out: ReturnType<AnnotationOverlay['snapshotLayout']> = [];
    for (const [id, entry] of this.entries) {
      const ann = this.annotations.find((a) => a.id === id);
      if (!ann || entry.label.style.display === 'none') continue;
      const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(entry.label.style.transform);
      const am = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(entry.anchor.style.transform);
      if (!m || !am) continue;
      out.push({
        id,
        text: ann.text,
        time: formatHM(ann.min),
        labelX: Number(m[1]),
        labelY: Number(m[2]),
        w: entry.label.offsetWidth,
        h: entry.label.offsetHeight,
        anchorX: Number(am[1]),
        anchorY: Number(am[2]),
        startX: Number(entry.path.dataset.startX ?? am[1]),
        startY: Number(entry.path.dataset.startY ?? am[2]),
        selected: ann.id === this.selectedId,
      });
    }
    return out;
  }

  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.label.remove();
      entry.anchor.remove();
      entry.path.remove();
    }
    this.entries.clear();
  }
}
