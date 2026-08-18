/**
 * Canvas compositing (PRD §3).
 *
 * Two canvases, stacked:
 *
 *   - **the composite** — camera feed, with Lucy's stream masked into the portal
 *     polygon. This is the picture. It is what gets recorded and exported, and
 *     nothing else is allowed into it.
 *   - **the overlay** — outline, labels, landmarks, on a transparent canvas
 *     above it (see overlay.ts). Preview-only, and reconstructible from data,
 *     which is what makes layered export possible at all.
 *
 * The composite is built in four steps:
 *
 *   1. draw the raw camera feed to the main canvas
 *   2. paint the "other dimension" into an offscreen layer (Lucy, or the flat
 *      dimension colour before its first frame decodes)
 *   3. rasterise the portal polygon into an offscreen mask with an even-odd fill
 *      and an optional blur (the feather)
 *   4. `destination-in` the mask onto the layer, then draw the layer on top
 *
 * Feathering therefore produces a true alpha ramp rather than a blurred colour.
 */

import type { Config } from './config';
import { polygonOrder, type PortalPoints, type Pt } from './geometry';
import type { TrackedHands } from './handTracking';
import {
  drawOverlay,
  emptyOverlayFrame,
  PORTAL_GREEN,
  type OverlayFrame,
  type OverlayLayers,
  type OverlayOutline,
} from './overlay';

// Re-exported so callers that only care about the resting colour do not have to
// know where the overlay lives.
export { PORTAL_GREEN };

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
  outline?: OverlayOutline;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement | null;
  private ctx: CanvasRenderingContext2D;
  private overlayCtx: CanvasRenderingContext2D | null;
  private layer: HTMLCanvasElement;
  private layerCtx: CanvasRenderingContext2D;
  private mask: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, overlay?: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = must(canvas.getContext('2d', { alpha: false }));
    this.overlay = overlay ?? null;
    this.overlayCtx = overlay ? must(overlay.getContext('2d')) : null;
    this.layer = document.createElement('canvas');
    this.layerCtx = must(this.layer.getContext('2d'));
    this.mask = document.createElement('canvas');
    this.maskCtx = must(this.mask.getContext('2d'));
  }

  resize(w: number, h: number): void {
    const all = [this.canvas, this.layer, this.mask, ...(this.overlay ? [this.overlay] : [])];
    for (const c of all) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
  }

  /**
   * The overlay for this frame, as data.
   *
   * Separate from drawing it because the same description feeds three
   * consumers: the live overlay canvas, the take recorder's frame track, and —
   * hours later — the review player. Building it once and handing the same
   * object to all three is what guarantees the exported overlay is identical to
   * the one that was on screen, rather than a re-derivation that can drift.
   *
   * `withHands` exists because landmarks are 21 points per hand per frame and
   * the render loop runs at 60fps. Building them when nothing will read them is
   * pure garbage.
   */
  buildOverlayFrame(input: RenderInput, cfg: Config, withHands: boolean): OverlayFrame {
    const frame = emptyOverlayFrame();
    frame.opacity = input.opacity;
    frame.outline = input.outline ?? { color: PORTAL_GREEN, width: 2, glow: 0 };
    if (input.portal) {
      frame.portal = polygonOrder(input.portal).map((p) => this.toScreen(p, cfg));
    }
    if (withHands) {
      frame.hands = input.hands.rawHands.map((h) => ({
        label: h.label,
        score: h.score,
        points: h.points.map((p) => this.toScreen(p, cfg)),
      }));
    }
    return frame;
  }

  /** Paint the composite. Overlays are **not** drawn here, by design. */
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
    }
  }

  /** Paint the live overlay canvas. No-op when the app supplied no overlay. */
  renderOverlay(frame: OverlayFrame, layers: OverlayLayers): void {
    if (this.overlayCtx) drawOverlay(this.overlayCtx, frame, layers);
  }

  private toScreen(p: Pt, cfg: Config): Pt {
    return cfg.mirror ? { x: this.canvas.width - p.x, y: p.y } : p;
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
