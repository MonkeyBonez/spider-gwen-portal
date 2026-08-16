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
 * How the close is detected (PRD §2.2.1).
 *
 * `strict`  index↔index and thumb↔thumb only — the original §2.2 rule. Misses the
 *           close entirely if a hand is rotated enough that the fingers meet
 *           their opposite number.
 * `paired`  the better of the two ways the hands can correspond: parallel
 *           (index↔index, thumb↔thumb) or crossed (index↔thumb, thumb↔index).
 *           Rotation-invariant, but still needs *both* pairs closed, so the
 *           portal has to actually be shut. Default.
 * `any`     the single closest pair of points across the two hands. The literal
 *           "any two points from opposite hands touching" — most permissive, and
 *           see the hinge caveat below.
 */
export type ContactMode = 'strict' | 'paired' | 'any';

export const CONTACT_MODES: ContactMode[] = ['strict', 'paired', 'any'];

export const CONTACT_BLURBS: Record<ContactMode, string> = {
  strict: 'Index↔index and thumb↔thumb only. Breaks if a hand rotates.',
  paired: 'Best of the parallel or crossed pairing. Rotation-proof, still needs the portal shut.',
  any: 'Closest single cross-hand pair. Most forgiving — but a thumb-pivot hinge never reads as open.',
};

/**
 * How the two sides of the portal combine into one number (PRD §2.2.1).
 *
 * A plain mean lets one side cancel out the other: index fingers 0.6 hand-widths
 * apart with the thumbs touching averages to 0.30, under a 0.35 close threshold,
 * so a visibly open triangle latches CLOSED. `bias` interpolates away from that:
 *
 *   bias = 0  →  the mean. Exactly the old behaviour.
 *   bias = 1  →  `Math.max`, exactly — algebra, not approximation:
 *                mean + (max − mean) = max. Closed then means *both* sides are
 *                closed and a long side vetoes the close outright.
 *
 * Between the two, a long side forces the short one to be much smaller before the
 * close counts, which is the point.
 *
 * The property that makes this safe to add: for a symmetric pose (a === b) the
 * mean and the max are both `a`, so the reading is identical at every bias. Only
 * lopsided poses move, so the close/open thresholds do not need retuning.
 */
export function blendSides(a: number, b: number, bias: number): number {
  const k = Math.min(1, Math.max(0, bias));
  const mean = (a + b) / 2;
  return mean + (Math.max(a, b) - mean) * k;
}

/** Provisional until the ladder in `/closure.html` settles it (PRD §2.2.1). */
export const DEFAULT_WORST_SIDE_BIAS = 0.7;

/** The two cross-hand distances each pairing is built from, in pixels. */
function pairings(p: PortalPoints) {
  return {
    parallel: [dist(p.lIndex, p.rIndex), dist(p.lThumb, p.rThumb)] as const,
    crossed: [dist(p.lIndex, p.rThumb), dist(p.lThumb, p.rIndex)] as const,
  };
}

/**
 * `gap` = separation between the hands, normalised by hand size so it is
 * camera-distance invariant (PRD §2.2).
 *
 * Note that the three modes are on different scales — `any` reports roughly half
 * what `strict` does for the same pose, because it takes a minimum rather than a
 * mean. The close/open thresholds have to be retuned when the mode changes.
 * Changing `bias` does *not* require retuning; see `blendSides`.
 */
export function normalizedGap(
  p: PortalPoints,
  mode: ContactMode = 'paired',
  bias: number = DEFAULT_WORST_SIDE_BIAS,
): number {
  const { parallel, crossed } = pairings(p);
  const blend = (pair: readonly [number, number]) => blendSides(pair[0], pair[1], bias);

  let g: number;
  switch (mode) {
    case 'strict':
      g = blend(parallel);
      break;
    case 'any':
      // Every cross-hand pair among the portal points. Same-hand pairs are
      // excluded: index-to-own-thumb says nothing about the hands meeting.
      // No two-sided notion here, so `bias` does not apply.
      g = Math.min(...parallel, ...crossed);
      break;
    case 'paired':
    default:
      // The blend combines the two sides *within* a pairing; the min still picks
      // *between* the parallel and crossed pairings.
      g = Math.min(blend(parallel), blend(crossed));
      break;
  }
  return p.handSize > 0 ? g / p.handSize : 0;
}

/**
 * The two normalised side separations behind the current `gap`, for readouts.
 *
 * `strict` always reports the parallel pairing; `paired` reports whichever
 * pairing won. `any` has no two sides — it returns the single closest cross-hand
 * pair as both values, so a caller rendering "a / b" shows a matched pair rather
 * than something misleading.
 */
export function sideGaps(
  p: PortalPoints,
  mode: ContactMode = 'paired',
  bias: number = DEFAULT_WORST_SIDE_BIAS,
): { a: number; b: number } {
  const { parallel, crossed } = pairings(p);
  const scale = p.handSize > 0 ? p.handSize : 1;
  const norm = (pair: readonly [number, number]) => ({ a: pair[0] / scale, b: pair[1] / scale });

  switch (mode) {
    case 'strict':
      return norm(parallel);
    case 'any': {
      const closest = Math.min(...parallel, ...crossed) / scale;
      return { a: closest, b: closest };
    }
    case 'paired':
    default:
      return norm(
        blendSides(parallel[0], parallel[1], bias) <= blendSides(crossed[0], crossed[1], bias)
          ? parallel
          : crossed,
      );
  }
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
