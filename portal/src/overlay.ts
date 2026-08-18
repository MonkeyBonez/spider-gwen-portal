/**
 * Everything drawn *on top of* the composite: the portal outline, its corner
 * labels, and the hand landmarks.
 *
 * These used to be painted straight into the main canvas, which was fine while
 * the canvas was only ever looked at. It stops being fine the moment the canvas
 * is recorded (PRD §4.2): every exported video would carry a green rectangle
 * and `L-idx` labels burned into it, with no way to take them back out.
 *
 * So overlays live here, on their own transparent canvas, layered over the
 * composite with CSS — and, critically, as **data rather than pixels**. An
 * `OverlayFrame` is the complete description of one frame's overlay: four
 * screen-space points, a colour, and the landmarks. Recording that costs a few
 * hundred bytes a frame instead of a second video encoder, and it means the
 * review player can re-draw the overlay at any time, in any combination, long
 * after the take is over. Toggling a layer is a redraw, not a re-encode.
 *
 * **Points are stored post-mirror, in screen space.** The mirror is a capture
 * decision that can be changed between the take and the review, and geometry
 * recorded in source space would then land on the wrong side of a composite
 * that was already flipped when it was written. Screen space is the space the
 * composite is actually in, so it is the only one that stays true.
 */

import type { Pt } from './geometry';

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

/** Corner order matches `polygonOrder` in geometry.ts. */
const CORNER_LABELS = ['L-idx', 'R-idx', 'R-thm', 'L-thm'];

export interface OverlayHand {
  label: string;
  score: number;
  /** 21 MediaPipe landmarks, screen space. */
  points: Pt[];
}

export interface OverlayOutline {
  color: string;
  width: number;
  glow: number;
}

/** One frame's worth of overlay, complete and independent of live state. */
export interface OverlayFrame {
  /** Polygon corners in draw order, screen space. Null hides the portal. */
  portal: Pt[] | null;
  /** 0..1 portal fade, so the outline fades with the window it borders. */
  opacity: number;
  outline: OverlayOutline;
  hands: OverlayHand[];
}

/**
 * Which overlays to draw. Independent flags rather than one debug switch,
 * because the outline and the landmarks are different kinds of thing: the
 * outline is part of how the portal *looks*, the landmarks and labels are
 * instrumentation. The review player exposes that split directly.
 */
export interface OverlayLayers {
  /** The portal outline and its corner dots. */
  edge: boolean;
  /** `L-idx` / `R-thm` corner text and the per-hand confidence readout. */
  labels: boolean;
  /** MediaPipe skeletons. */
  landmarks: boolean;
}

export const NO_OVERLAYS: OverlayLayers = { edge: false, labels: false, landmarks: false };

/** True when nothing would be drawn — the export fast path checks this. */
export function overlaysEmpty(layers: OverlayLayers): boolean {
  return !layers.edge && !layers.labels && !layers.landmarks;
}

export function emptyOverlayFrame(): OverlayFrame {
  return {
    portal: null,
    opacity: 0,
    outline: { color: PORTAL_GREEN, width: 2, glow: 0 },
    hands: [],
  };
}

/** Clear `ctx` and paint `frame`, honouring `layers`. */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  layers: OverlayLayers,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (frame.portal && frame.opacity > 0.01 && (layers.edge || layers.labels)) {
    strokePortal(ctx, frame.portal, frame.outline, frame.opacity, layers);
  }
  if (layers.landmarks || layers.labels) drawHands(ctx, frame.hands, layers);
}

function strokePortal(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  outline: OverlayOutline,
  opacity: number,
  layers: OverlayLayers,
): void {
  ctx.save();
  // The outline belongs to the portal, so it fades with it. Drawn at full
  // strength it hung in the air for 120ms after the window it bordered had
  // gone.
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = outline.color;
  ctx.fillStyle = outline.color;
  ctx.lineWidth = outline.width;
  // Glow only while something is actually happening. Tying it to line width
  // meant the outline glowed permanently, which drowned the flash it was
  // supposed to make legible — a status light that is always lit says nothing.
  if (outline.glow > 0) {
    ctx.shadowColor = outline.color;
    ctx.shadowBlur = outline.glow;
  }
  if (layers.edge) {
    ctx.stroke(pathOf(pts));
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 + outline.width * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (layers.labels) {
    ctx.shadowBlur = 0;
    ctx.font = '600 14px ui-monospace, monospace';
    pts.forEach((p, i) => ctx.fillText(CORNER_LABELS[i] ?? String(i), p.x + 8, p.y - 8));
  }
  ctx.restore();
}

function drawHands(
  ctx: CanvasRenderingContext2D,
  hands: OverlayHand[],
  layers: OverlayLayers,
): void {
  ctx.save();
  ctx.lineWidth = 2;
  for (const hand of hands) {
    const pts = hand.points;
    if (pts.length === 0) continue;
    const color = hand.label === 'Left' ? 'rgba(90,170,255,0.8)' : 'rgba(255,140,90,0.8)';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (layers.landmarks) {
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        if (!pts[a] || !pts[b]) continue;
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (layers.labels) {
      ctx.font = '600 16px ui-monospace, monospace';
      ctx.fillText(`${hand.label} ${hand.score.toFixed(2)}`, pts[0].x + 10, pts[0].y + 20);
    }
  }
  ctx.restore();
}

function pathOf(pts: Pt[]): Path2D {
  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
  return path;
}
