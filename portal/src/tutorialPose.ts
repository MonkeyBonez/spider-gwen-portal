/**
 * The hand-shaped targets the tutorial asks people to fill.
 *
 * ## Why this is generated rather than an SVG
 *
 * Searched for a ready-made asset first (2026-08-23): icon sets, ASL handshape
 * repos, stock "finger frame" art. Nothing usable — single hands at icon scale,
 * wrong orientation, or licensed. More importantly none of them would be in
 * *landmark space*, and that is the whole point here:
 *
 * - The outline is drawn from the same 21 landmarks and the same
 *   `HAND_CONNECTIONS` the tracker reports, so "are your hands in the outline?"
 *   is a comparison between two sets of the same kind of thing, not an image
 *   test.
 * - The index and thumb tips of the outline are placed *exactly* on the portal
 *   corners the app would compute from real hands, so filling the outline puts
 *   the portal precisely where the guide promised it.
 * - Moving the guide outwards for step 2 is a parameter, not new artwork.
 *
 * ## The pose
 *
 * `BASE_L_POSE` is one hand in a unit space: wrist at the origin, fingers up
 * (canvas y grows downward, so up is negative), index extended, thumb out at
 * roughly a right angle, the other three curled into the palm. Distances are in
 * *hand sizes* — landmark 9 (middle MCP) sits exactly 1.0 from the wrist,
 * matching `HandPoints.size`, so a scale factor here means the same thing it
 * means everywhere else in the codebase.
 *
 * ## Placement is a two-point fit, not hand-tuned angles
 *
 * `fitPose` solves the unique similarity transform (rotate + uniform scale +
 * translate) taking the base index tip and thumb tip onto two chosen targets.
 * Feed it two portal corners and the whole hand follows. No trigonometry to get
 * wrong, and the tips land on the corners to the pixel.
 *
 * Chirality is not decorative: a hand's body must fall *outside* the portal, or
 * the guide would ask people to put their palm where the window goes. The
 * screen-right hand uses the base pose and the screen-left hand uses its
 * x-mirror, which is what puts each thumb on the side facing the portal.
 */

import type { Pt } from './geometry';

/**
 * One right hand, palm to camera, making an L. Unit space, y-down, wrist at 0.
 *
 * Index order is MediaPipe's: 0 wrist, 1–4 thumb, 5–8 index, 9–12 middle,
 * 13–16 ring, 17–20 pinky.
 */
export const BASE_L_POSE: readonly Pt[] = [
  { x: 0, y: 0 },          // 0  wrist

  { x: -0.18, y: -0.12 },  // 1  thumb CMC
  { x: -0.50, y: -0.20 },  // 2  thumb MCP
  { x: -0.84, y: -0.24 },  // 3  thumb IP
  { x: -1.14, y: -0.26 },  // 4  thumb tip

  { x: -0.30, y: -0.95 },  // 5  index MCP
  { x: -0.33, y: -1.42 },  // 6  index PIP
  { x: -0.35, y: -1.72 },  // 7  index DIP
  { x: -0.36, y: -1.98 },  // 8  index tip

  { x: 0.0, y: -1.0 },     // 9  middle MCP — 1.0 from the wrist, by definition
  { x: 0.06, y: -1.32 },   // 10 middle PIP
  { x: 0.02, y: -1.12 },   // 11 middle DIP   (curled back toward the palm)
  { x: -0.04, y: -0.92 },  // 12 middle tip

  { x: 0.28, y: -0.95 },   // 13 ring MCP
  { x: 0.36, y: -1.24 },   // 14 ring PIP
  { x: 0.32, y: -1.05 },   // 15 ring DIP
  { x: 0.26, y: -0.88 },   // 16 ring tip

  { x: 0.52, y: -0.82 },   // 17 pinky MCP
  { x: 0.60, y: -1.05 },   // 18 pinky PIP
  { x: 0.57, y: -0.90 },   // 19 pinky DIP
  { x: 0.51, y: -0.76 },   // 20 pinky tip
];

/** Landmarks bounding the palm, filled so the silhouette is solid. */
export const PALM_LOOP = [0, 1, 5, 9, 13, 17];

const INDEX_TIP = 8;
const THUMB_TIP = 4;
const MIDDLE_MCP = 9;

/** A placed outline: landmarks in screen space, plus the scale used. */
export interface PoseOutline {
  points: Pt[];
  /** Wrist→middle-MCP distance in px — the same measure as `HandPoints.size`. */
  handSize: number;
  /** Where this hand's index tip sits, i.e. a portal corner. */
  indexTip: Pt;
  /** Where this hand's thumb tip sits, i.e. a portal corner. */
  thumbTip: Pt;
}

/** The pair of guides for one step, plus the portal they frame. */
export interface OutlinePair {
  left: PoseOutline;
  right: PoseOutline;
}

function mirrored(pose: readonly Pt[]): Pt[] {
  return pose.map((p) => ({ x: -p.x, y: p.y }));
}

/**
 * Place `pose` so its index and thumb tips land on `indexTarget`/`thumbTarget`.
 *
 * The similarity transform through two point pairs is unique and closed-form:
 * treating points as complex numbers, the rotation-and-scale factor is the
 * ratio of the target span to the source span. Degenerate input (coincident
 * source tips) can't happen with a fixed pose, but is guarded anyway so a bad
 * edit fails visibly rather than filling the canvas with NaN.
 */
export function fitPose(pose: readonly Pt[], indexTarget: Pt, thumbTarget: Pt): PoseOutline {
  const src = pose[INDEX_TIP];
  const anchor = pose[THUMB_TIP];
  const ux = src.x - anchor.x;
  const uy = src.y - anchor.y;
  const vx = indexTarget.x - thumbTarget.x;
  const vy = indexTarget.y - thumbTarget.y;
  const denom = ux * ux + uy * uy;
  if (denom === 0) throw new Error('tutorialPose: base pose has coincident tips');
  // v / u, in complex arithmetic: a is scale·cosθ, b is scale·sinθ.
  const a = (vx * ux + vy * uy) / denom;
  const b = (vy * ux - vx * uy) / denom;
  const scale = Math.hypot(a, b);

  const points = pose.map((p) => {
    const dx = p.x - anchor.x;
    const dy = p.y - anchor.y;
    return {
      x: thumbTarget.x + a * dx - b * dy,
      y: thumbTarget.y + b * dx + a * dy,
    };
  });

  const wrist = points[0];
  const mcp = points[MIDDLE_MCP];
  return {
    points,
    handSize: Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y) || scale,
    indexTip: points[INDEX_TIP],
    thumbTip: points[THUMB_TIP],
  };
}

/**
 * The two guides for a step, framing a portal of the given size.
 *
 * `halfWidth`/`halfHeight` are fractions of the frame, so the guides scale with
 * the canvas. The corners map onto `PortalPoints` exactly: left hand takes the
 * two left corners (index above, thumb below), right hand the two right ones.
 */
export function outlinePair(
  width: number,
  height: number,
  halfWidth: number,
  halfHeight: number,
  centerY = 0.5,
): OutlinePair {
  const cx = width / 2;
  const cy = height * centerY;
  const hw = width * halfWidth;
  const hh = height * halfHeight;
  return {
    left: fitPose(mirrored(BASE_L_POSE), { x: cx - hw, y: cy - hh }, { x: cx - hw, y: cy + hh }),
    right: fitPose(BASE_L_POSE, { x: cx + hw, y: cy - hh }, { x: cx + hw, y: cy + hh }),
  };
}
