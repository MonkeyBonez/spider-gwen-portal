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
 * Which overlays to draw.
 *
 * Two flags, split by *audience* rather than by what is being drawn. `portal`
 * is the whole portal as a thing you would show someone — outline, corner
 * points and their labels together, because splitting them only ever produced
 * combinations nobody wanted (labels floating on a bare polygon). `landmarks`
 * is tuning instrumentation, live-only: takes never carry landmark data, so
 * this is always false in review.
 */
export interface OverlayLayers {
  /** Portal outline, corner dots, and the corner labels. */
  portal: boolean;
  /** MediaPipe skeletons and per-hand confidence. Live tuning only. */
  landmarks: boolean;
}

export const NO_OVERLAYS: OverlayLayers = { portal: false, landmarks: false };

/** True when nothing would be drawn — the export fast path checks this. */
export function overlaysEmpty(layers: OverlayLayers): boolean {
  return !layers.portal && !layers.landmarks;
}

export function emptyOverlayFrame(): OverlayFrame {
  return {
    portal: null,
    opacity: 0,
    outline: { color: PORTAL_GREEN, width: 2, glow: 0 },
    hands: [],
  };
}

/**
 * Paint `frame` onto `ctx`, honouring `layers`.
 *
 * **Draws only — it must never clear.** The two live callers own a dedicated
 * transparent canvas and clear it themselves before calling; the export draws
 * the video frame and then this, *onto the same canvas*. Clearing here erased
 * the video and shipped files containing a portal outline on black, which is
 * exactly what happened once (2026-08-18) and is what `does not clear` in the
 * tests pins.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  layers: OverlayLayers,
): void {
  if (frame.portal && frame.opacity > 0.01 && layers.portal) {
    strokePortal(ctx, frame.portal, frame.outline, frame.opacity);
  }
  if (layers.landmarks) drawHands(ctx, frame.hands);
}

function strokePortal(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  outline: OverlayOutline,
  opacity: number,
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
  ctx.stroke(pathOf(pts));
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 + outline.width * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Labels unglowed — the glow is the switch flash, and smearing it across text
  // makes the text the loudest thing in frame at exactly the wrong moment.
  ctx.shadowBlur = 0;
  ctx.font = '600 14px ui-monospace, monospace';
  pts.forEach((p, i) => ctx.fillText(CORNER_LABELS[i] ?? String(i), p.x + 8, p.y - 8));
  ctx.restore();
}

function drawHands(ctx: CanvasRenderingContext2D, hands: OverlayHand[]): void {
  ctx.save();
  ctx.lineWidth = 2;
  for (const hand of hands) {
    const pts = hand.points;
    if (pts.length === 0) continue;
    const color = hand.label === 'Left' ? 'rgba(90,170,255,0.8)' : 'rgba(255,140,90,0.8)';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
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
    ctx.font = '600 16px ui-monospace, monospace';
    ctx.fillText(`${hand.label} ${hand.score.toFixed(2)}`, pts[0].x + 10, pts[0].y + 20);
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
