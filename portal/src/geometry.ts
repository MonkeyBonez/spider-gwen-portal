/**
 * Portal geometry (PRD §2.1).
 *
 * All maths happens in *pixel* space of the capture frame so that distances are
 * aspect-correct. Normalisation by hand size makes the signals camera-distance
 * invariant.
 */

export interface Pt {
  x: number;
  y: number;
}

/** MediaPipe hand landmark indices we care about. */
export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
} as const;

export interface HandPoints {
  thumb: Pt;
  index: Pt;
  /** wrist → middle-finger MCP distance, used as the scale reference. */
  size: number;
  score: number;
}

export interface PortalPoints {
  lIndex: Pt;
  rIndex: Pt;
  rThumb: Pt;
  lThumb: Pt;
  /** Mean of the two hand sizes. */
  handSize: number;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerpPt(from: Pt, to: Pt, alpha: number): Pt {
  return {
    x: from.x + (to.x - from.x) * alpha,
    y: from.y + (to.y - from.y) * alpha,
  };
}

/**
 * Fixed traversal order: L-index → R-index → R-thumb → L-thumb (PRD §2.1).
 * With an even-odd fill this yields a quad when the hands are level and a
 * two-triangle bowtie when one hand rotates — no special-casing.
 */
export function polygonOrder(p: PortalPoints): Pt[] {
  return [p.lIndex, p.rIndex, p.rThumb, p.lThumb];
}

/** Signed shoelace area, absolute value. For a bowtie the lobes partly cancel. */
export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * `gap` = mean of the index-to-index and thumb-to-thumb distances, normalised by
 * hand size (PRD §2.2).
 */
export function normalizedGap(p: PortalPoints): number {
  const g = (dist(p.lIndex, p.rIndex) + dist(p.lThumb, p.rThumb)) / 2;
  return p.handSize > 0 ? g / p.handSize : 0;
}

/** Polygon area normalised by hand size squared. */
export function normalizedArea(p: PortalPoints): number {
  const a = polygonArea(polygonOrder(p));
  return p.handSize > 0 ? a / (p.handSize * p.handSize) : 0;
}

/** Smooth the 4 portal points toward a new observation with a per-point EMA. */
export function smoothPortal(
  prev: PortalPoints | null,
  next: PortalPoints,
  alpha: number,
): PortalPoints {
  if (!prev || alpha >= 1) return next;
  return {
    lIndex: lerpPt(prev.lIndex, next.lIndex, alpha),
    rIndex: lerpPt(prev.rIndex, next.rIndex, alpha),
    rThumb: lerpPt(prev.rThumb, next.rThumb, alpha),
    lThumb: lerpPt(prev.lThumb, next.lThumb, alpha),
    handSize: prev.handSize + (next.handSize - prev.handSize) * alpha,
  };
}
