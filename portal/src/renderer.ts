/**
 * Canvas compositing (PRD §3).
 *
 * The composite is built the way Phase 1 will need it, so swapping the solid
 * colour for Lucy's <video> is a one-line change:
 *
 *   1. draw the raw camera feed to the main canvas
 *   2. paint the "other dimension" into an offscreen layer (colour now, Lucy later)
 *   3. rasterise the portal polygon into an offscreen mask with an even-odd fill
 *      and an optional blur (the feather)
 *   4. `destination-in` the mask onto the layer, then draw the layer on top
 *
 * Feathering therefore produces a true alpha ramp rather than a blurred colour.
 */

import type { Config } from './config';
import { polygonOrder, type PortalPoints, type Pt } from './geometry';
import type { TrackedHands } from './handTracking';

/** Resting outline colour — the portal's "nominal" state. */
export const PORTAL_GREEN = 'rgba(0,255,180,0.9)';

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export interface RenderInput {
  /**
   * The base layer. Normally the live camera element; when sync compensation
   * is on it is a delayed *copy* of it from the ring buffer, which is why this
   * is the general image type rather than a video element (PRD §2.3 V2).
   */
  video: CanvasImageSource;
  hands: TrackedHands;
  /** Smoothed portal, or null when the portal should be hidden. */
  portal: PortalPoints | null;
  /** 0..1 fade so the portal doesn't pop when a hand drops out (§2.1). */
  opacity: number;
  fill: string;
  /**
   * Lucy's stream, drawn inside the portal when it has decoded frames. Null
   * falls back to the flat `fill` colour, which is what covers the ~4–5s cold
   * start (PRD §2.3.1) and Phase 0's no-Lucy mode with the same code path.
   */
  source?: HTMLVideoElement | null;
  /**
   * How much of `source` to show, 0–1. Below 1 the dimension colour shows
   * through underneath — this is the reveal cross-fade (PRD §4.1).
   */
  sourceAlpha?: number;
  /**
   * Colour and weight of the portal outline and its corner points.
   *
   * The outline doubles as the session's status light (PRD §1.1's "device"
   * direction): it reports where a dimension switch has got to, in the one
   * place the performer is already looking. Defaults preserve the original
   * fixed teal when nothing sets it.
   */
  outline?: { color: string; width: number; glow?: number };
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layer: HTMLCanvasElement;
  private layerCtx: CanvasRenderingContext2D;
  private mask: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = must(canvas.getContext('2d', { alpha: false }));
    this.layer = document.createElement('canvas');
    this.layerCtx = must(this.layer.getContext('2d'));
    this.mask = document.createElement('canvas');
    this.maskCtx = must(this.mask.getContext('2d'));
  }

  resize(w: number, h: number): void {
    for (const c of [this.canvas, this.layer, this.mask]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
  }

  render(input: RenderInput, cfg: Config): void {
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;

    // 1. raw feed
    ctx.save();
    if (cfg.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(input.video, 0, 0, w, h);
    ctx.restore();

    // 2–4. portal
    if (input.portal && input.opacity > 0.01) {
      const pts = polygonOrder(input.portal).map((p) => this.toScreen(p, cfg));

      // The dimension colour is the floor the portal contents sit on. It shows
      // alone during Lucy's cold start, and it is what the reveal cross-fades
      // up from after a switch — one mechanism, not two.
      const alpha = input.source ? Math.min(1, Math.max(0, input.sourceAlpha ?? 1)) : 0;
      this.layerCtx.clearRect(0, 0, w, h);
      if (alpha < 1) {
        this.layerCtx.fillStyle = input.fill;
        this.layerCtx.fillRect(0, 0, w, h);
      }
      if (input.source && alpha > 0) {
        // Lucy's frame has to carry the *same* mirror transform as the raw feed
        // in step 1. The mask is built in screen space, so drawing the portal
        // contents unmirrored would put a correctly-placed window over a
        // laterally-flipped world — the seam at the polygon edge would jump.
        this.layerCtx.save();
        this.layerCtx.globalAlpha = alpha;
        if (cfg.mirror) {
          this.layerCtx.translate(w, 0);
          this.layerCtx.scale(-1, 1);
        }
        drawCover(this.layerCtx, input.source, w, h);
        this.layerCtx.restore();
      }

      this.maskCtx.clearRect(0, 0, w, h);
      this.maskCtx.save();
      if (cfg.feather > 0) this.maskCtx.filter = `blur(${cfg.feather}px)`;
      this.maskCtx.fillStyle = '#fff';
      this.maskCtx.fill(pathOf(pts), 'evenodd');
      this.maskCtx.restore();

      this.layerCtx.globalCompositeOperation = 'destination-in';
      this.layerCtx.drawImage(this.mask, 0, 0);
      this.layerCtx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.globalAlpha = input.opacity;
      ctx.drawImage(this.layer, 0, 0);
      ctx.restore();

      if (cfg.showPolygonOutline) this.strokePortal(pts, input.outline);
    }

    if (cfg.showLandmarks) this.drawLandmarks(input.hands, cfg);
  }

  private toScreen(p: Pt, cfg: Config): Pt {
    return cfg.mirror ? { x: this.canvas.width - p.x, y: p.y } : p;
  }

  private strokePortal(
    pts: Pt[],
    outline?: { color: string; width: number; glow?: number },
  ): void {
    const ctx = this.ctx;
    const color = outline?.color ?? PORTAL_GREEN;
    const width = outline?.width ?? 2;
    const glow = outline?.glow ?? 0;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    // Glow only while something is actually happening. Tying it to line width
    // meant the outline glowed permanently, which drowned the flash it was
    // supposed to make legible — a status light that is always lit says nothing.
    if (glow > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = glow;
    }
    ctx.stroke(pathOf(pts));
    const labels = ['L-idx', 'R-idx', 'R-thm', 'L-thm'];
    ctx.font = '600 14px ui-monospace, monospace';
    ctx.fillStyle = color;
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 + width * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(labels[i], p.x + 8, p.y - 8);
    });
    ctx.restore();
  }

  private drawLandmarks(hands: TrackedHands, cfg: Config): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    for (const hand of hands.rawHands) {
      const pts = hand.points.map((p) => this.toScreen(p, cfg));
      ctx.strokeStyle = hand.label === 'Left' ? 'rgba(90,170,255,0.8)' : 'rgba(255,140,90,0.8)';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.font = '600 16px ui-monospace, monospace';
      ctx.fillText(
        `${hand.label} ${hand.score.toFixed(2)}`,
        pts[0].x + 10,
        pts[0].y + 20,
      );
    }
    ctx.restore();
  }
}

/**
 * Draw `src` filling `w`×`h`, cropping the overflow rather than stretching.
 *
 * `lucy-2.5` is 1280×720 and so is our canvas, so this is normally a straight
 * 1:1 blit. It exists for the cases where it isn't — a camera that ignored the
 * requested size, or a model with a different aspect (`lucy-restyle-2` is
 * 1280×704). Letterboxing would misalign the portal contents against the mask;
 * cropping keeps the centre of the frame where the performer is.
 */
function drawCover(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement,
  w: number,
  h: number,
): void {
  const sw = src.videoWidth;
  const sh = src.videoHeight;
  if (sw === 0 || sh === 0) return;
  if (sw === w && sh === h) {
    ctx.drawImage(src, 0, 0);
    return;
  }
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function pathOf(pts: Pt[]): Path2D {
  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
  return path;
}

function must<T>(v: T | null): T {
  if (!v) throw new Error('2D canvas context unavailable');
  return v;
}
