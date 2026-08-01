import * as fabric from 'fabric';
import { DRAWING_COLOR, MASK_OVERLAY_COLOR, MAX_ZOOM, MIN_ZOOM } from '@aie/shared';
import type { Point, SelectionTool } from '@aie/types';
import { boxFromPoints, type StrokeHint } from '@aie/canvas';

/**
 * Thin wrapper around a Fabric.js canvas implementing the editor's layering:
 *
 *   Result preview   (top)
 *   Selection overlay (SAM mask highlight)
 *   Drawing layer    (user strokes)
 *   Original image   (base)
 *   Background       (checkerboard)
 *
 * It also records brush/rect/ellipse/lasso strokes as normalized hints and
 * supports zoom/pan.
 */

export interface CanvasCallbacks {
  onHintChange: (hint: StrokeHint | null) => void;
  onStrokeStart?: () => void;
  onStrokeEnd?: () => void;
}

export class EditorCanvas {
  private canvas: fabric.Canvas;
  private image: fabric.Image | null = null;
  private overlay: fabric.Image | null = null;
  private drawLayer: fabric.Group | null = null;
  private drawing = false;
  private currentTool: SelectionTool = 'brush';
  private currentPath: fabric.Path | null = null;
  private currentRect: fabric.Rect | null = null;
  private currentEllipse: fabric.Ellipse | null = null;
  private currentPolyline: fabric.Polyline | null = null;
  private strokePoints: Point[] = [];
  private startPoint: Point | null = null;
  private lastPan: Point | null = null;
  private cb: CanvasCallbacks;
  private disposed = false;

  // normalized image-space bounds (0..1)
  private bounds = { left: 0, top: 0, width: 1, height: 1 };

  constructor(
    private host: HTMLCanvasElement,
    private width: number,
    private height: number,
    cb: CanvasCallbacks,
  ) {
    this.cb = cb;
    this.canvas = new fabric.Canvas(host, {
      width,
      height,
      selection: false,
      preserveObjectStacking: true,
      renderOnAddRemove: false,
    });
    this.canvas.backgroundColor = 'transparent';
    this.bindEvents();
  }

  get instance() {
    return this.canvas;
  }

  setSize(w: number, h: number): void {
    this.canvas.setWidth(w);
    this.canvas.setHeight(h);
  }

  async setBaseImage(url: string): Promise<void> {
    const img = await fabric.Image.fromURL(url, { crossOrigin: 'anonymous' });
    if (this.disposed) return;
    if (this.image) this.canvas.remove(this.image);
    this.image = img;
    img.set({ left: 0, top: 0, selectable: false, evented: false });
    this.canvas.add(img);
    this.bounds = { left: 0, top: 0, width: img.width ?? 1, height: img.height ?? 1 };
    this.fitToScreen();
    this.render();
  }

  setResultImage(url: string): Promise<void> {
    return this.setBaseImage(url);
  }

  /** Show the SAM mask overlay (already sized to image). */
  async setMaskOverlay(maskUrl: string): Promise<void> {
    const img = await fabric.Image.fromURL(maskUrl, { crossOrigin: 'anonymous' });
    if (this.disposed) return;
    if (this.overlay) this.canvas.remove(this.overlay);
    this.overlay = img;
    img.set({
      left: 0,
      top: 0,
      selectable: false,
      evented: false,
      opacity: 0.45,
      filters: [new fabric.filters.BlendColor({ color: '#22d3ee', mode: 'tint' })],
    });
    img.applyFilters();
    this.canvas.add(img);
    img.sendToBack();
    this.overlay.moveTo(1);
    this.render();
  }

  clearMaskOverlay(): void {
    if (this.overlay) {
      this.canvas.remove(this.overlay);
      this.overlay = null;
    }
    this.render();
  }

  setTool(tool: SelectionTool): void {
    this.currentTool = tool;
    this.canvas.selection = false;
    this.canvas.defaultCursor = tool === 'pan' ? 'grab' : 'crosshair';
    this.canvas.hoverCursor = this.canvas.defaultCursor;
  }

  zoomBy(factor: number, center?: Point): void {
    const pt = center ?? { x: this.width / 2, y: this.height / 2 };
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.canvas.getZoom() * factor));
    this.canvas.zoomToPoint(new fabric.Point(pt.x, pt.y), zoom);
    this.render();
  }

  zoomToFit(): void {
    this.fitToScreen();
  }

  resetZoom(): void {
    this.canvas.setZoom(1);
    this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    this.render();
  }

  private fitToScreen(): void {
    if (!this.image) return;
    const iw = this.image.width ?? this.width;
    const ih = this.image.height ?? this.height;
    const scale = Math.min((this.width - 48) / iw, (this.height - 48) / ih, 1);
    this.canvas.setZoom(scale);
    this.canvas.viewportTransform = [scale, 0, 0, scale, (this.width - iw * scale) / 2, (this.height - ih * scale) / 2];
  }

  getImageDataUrl(format: 'png' | 'jpeg' = 'png', quality = 0.92): string {
    return this.canvas.toDataURL({ format, quality, multiplier: 1 });
  }

  exportDataUrl(): string {
    return this.canvas.toDataURL({ format: 'png', multiplier: 1 });
  }

  clearDrawing(): void {
    if (this.drawLayer) {
      this.canvas.remove(this.drawLayer);
      this.drawLayer = null;
    }
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.canvas.dispose();
  }

  // ---------------------------------------------------------------------------
  // Drawing / selection
  // ---------------------------------------------------------------------------
  private bindEvents(): void {
    const c = this.canvas;

    c.on('mouse:down', (opt) => {
      const p = this.toImagePoint(opt.e);
      this.startPoint = p;
      this.strokePoints = [p];
      const tool = this.currentTool;
      if (tool === 'brush' || tool === 'magic') {
        this.drawing = true;
        this.currentPath = new fabric.Path(`M ${p.x} ${p.y}`, {
          stroke: DRAWING_COLOR,
          strokeWidth: 3 / this.canvas.getZoom(),
          fill: '',
          strokeLineCap: 'round',
          strokeLineJoin: 'round',
          selectable: false,
          evented: false,
        });
        this.addToDrawLayer(this.currentPath);
      } else if (tool === 'rect') {
        this.drawing = true;
        this.currentRect = new fabric.Rect({
          left: p.x,
          top: p.y,
          width: 0,
          height: 0,
          fill: 'rgba(34,211,238,0.12)',
          stroke: DRAWING_COLOR,
          strokeWidth: 1.5 / this.canvas.getZoom(),
          selectable: false,
          evented: false,
        });
        this.addToDrawLayer(this.currentRect);
      } else if (tool === 'ellipse') {
        this.drawing = true;
        this.currentEllipse = new fabric.Ellipse({
          left: p.x,
          top: p.y,
          rx: 0,
          ry: 0,
          fill: 'rgba(34,211,238,0.12)',
          stroke: DRAWING_COLOR,
          strokeWidth: 1.5 / this.canvas.getZoom(),
          selectable: false,
          evented: false,
        });
        this.addToDrawLayer(this.currentEllipse);
      } else if (tool === 'lasso') {
        this.drawing = true;
        this.currentPolyline = new fabric.Polyline([{ x: p.x, y: p.y }], {
          stroke: DRAWING_COLOR,
          strokeWidth: 2 / this.canvas.getZoom(),
          fill: 'rgba(34,211,238,0.08)',
          strokeLineCap: 'round',
          strokeLineJoin: 'round',
          selectable: false,
          evented: false,
        });
        this.addToDrawLayer(this.currentPolyline);
      } else if (tool === 'pan') {
        this.canvas.isDragging = true;
        this.canvas.selection = false;
        this.lastPan = p;
        this.canvas.defaultCursor = 'grabbing';
      }
      this.cb.onStrokeStart?.();
    });

    c.on('mouse:move', (opt) => {
      const p = this.toImagePoint(opt.e);
      if (this.drawing && this.currentPath) {
        this.strokePoints.push(p);
        const path = (this.currentPath.path as unknown[][]) ?? [];
        path.push(['L', p.x, p.y]);
        this.currentPath.set({ path: path as fabric.Point[] });
        this.render();
      } else if (this.drawing && this.currentRect && this.startPoint) {
        const w = Math.abs(p.x - this.startPoint.x);
        const h = Math.abs(p.y - this.startPoint.y);
        this.currentRect.set({
          left: Math.min(p.x, this.startPoint.x),
          top: Math.min(p.y, this.startPoint.y),
          width: w,
          height: h,
        });
        this.render();
      } else if (this.drawing && this.currentEllipse && this.startPoint) {
        const w = Math.abs(p.x - this.startPoint.x);
        const h = Math.abs(p.y - this.startPoint.y);
        this.currentEllipse.set({
          left: Math.min(p.x, this.startPoint.x),
          top: Math.min(p.y, this.startPoint.y),
          rx: w / 2,
          ry: h / 2,
        });
        this.render();
      } else if (this.drawing && this.currentPolyline) {
        this.strokePoints.push(p);
        this.currentPolyline.set({ points: this.strokePoints.map((pt) => ({ x: pt.x, y: pt.y })) });
        this.render();
      } else if (this.canvas.isDragging && this.lastPan) {
        const vpt = this.canvas.viewportTransform;
        if (!vpt) return;
        vpt[4] += p.x - this.lastPan.x;
        vpt[5] += p.y - this.lastPan.y;
        this.lastPan = p;
        this.render();
      }
    });

    c.on('mouse:up', () => {
      const tool = this.currentTool;
      if (this.drawing) {
        this.drawing = false;
        this.emitHint(tool);
        this.currentPath = null;
        this.currentRect = null;
        this.currentEllipse = null;
        this.currentPolyline = null;
        this.cb.onStrokeEnd?.();
      }
      if (this.canvas.isDragging) {
        this.canvas.isDragging = false;
        this.canvas.defaultCursor = 'grab';
      }
    });

    c.on('mouse:wheel', (opt) => {
      const delta = opt.e.deltaY;
      const factor = delta < 0 ? 1.1 : 1 / 1.1;
      const pt = { x: opt.e.offsetX, y: opt.e.offsetY };
      this.zoomBy(factor, pt);
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });
  }

  private emitHint(tool: SelectionTool): void {
    const points = this.strokePoints;
    if (points.length === 0) {
      this.cb.onHintChange(null);
      return;
    }
    const w = this.bounds.width;
    const h = this.bounds.height;
    const norm = (p: Point) => ({ x: (p.x - this.bounds.left) / w, y: (p.y - this.bounds.top) / h });

    if (tool === 'brush') {
      this.cb.onHintChange({ kind: 'brush', points: points.map(norm) });
    } else if (tool === 'rect') {
      const [x0, y0, x1, y1] = boxFromPoints(points[0], points[points.length - 1], w, h);
      this.cb.onHintChange({ kind: 'box', box: [x0, y0, x1, y1] });
    } else if (tool === 'ellipse') {
      const [x0, y0, x1, y1] = boxFromPoints(points[0], points[points.length - 1], w, h);
      this.cb.onHintChange({ kind: 'box', box: [x0, y0, x1, y1] });
    } else if (tool === 'lasso') {
      this.cb.onHintChange({ kind: 'brush', points: points.map(norm) });
    } else if (tool === 'magic') {
      this.cb.onHintChange({ kind: 'brush', points: points.map(norm) });
    }
  }

  private addToDrawLayer(obj: fabric.Object): void {
    if (!this.drawLayer) {
      this.drawLayer = new fabric.Group([], { selectable: false, evented: false });
      this.canvas.add(this.drawLayer);
    }
    this.drawLayer.add(obj);
  }

  private toImagePoint(e: MouseEvent | WheelEvent): Point {
    const rect = this.host.getBoundingClientRect();
    const x = (e.clientX - rect.left - (this.canvas.viewportTransform?.[4] ?? 0)) / (this.canvas.getZoom() || 1);
    const y = (e.clientY - rect.top - (this.canvas.viewportTransform?.[5] ?? 0)) / (this.canvas.getZoom() || 1);
    return { x, y };
  }

  private render(): void {
    if (!this.disposed) this.canvas.requestRenderAll();
  }
}
