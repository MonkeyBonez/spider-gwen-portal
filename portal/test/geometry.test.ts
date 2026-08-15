/**
 * Portal geometry (PRD §2.1). The load-bearing claim is that the fixed
 * traversal order L-index → R-index → R-thumb → L-thumb self-intersects into a
 * bowtie when one hand rotates, so an even-odd fill gives the two-triangle
 * shape with no special-case code. These tests pin the traversal order and the
 * self-intersection; the *rendering* of the even-odd fill is verified visually
 * in /verify.html.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizedGap,
  polygonArea,
  polygonOrder,
  smoothPortal,
  type PortalPoints,
  type Pt,
} from '../src/geometry';

/** Hands level: index fingers on top, thumbs below → convex quad. */
const LEVEL: PortalPoints = {
  lIndex: { x: 100, y: 100 },
  rIndex: { x: 300, y: 100 },
  rThumb: { x: 300, y: 300 },
  lThumb: { x: 100, y: 300 },
  handSize: 100,
};

/** Left hand rotated so its index points down → self-intersecting bowtie. */
const ROTATED: PortalPoints = {
  lIndex: { x: 100, y: 300 },
  rIndex: { x: 300, y: 100 },
  rThumb: { x: 300, y: 300 },
  lThumb: { x: 100, y: 100 },
  handSize: 100,
};

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (p: Pt, q: Pt, r: Pt) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** True if the closed polygon crosses itself (the bowtie case). */
function selfIntersects(pts: Pt[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segmentsIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) {
        return true;
      }
    }
  }
  return false;
}

describe('portal polygon', () => {
  it('uses the fixed L-index → R-index → R-thumb → L-thumb order', () => {
    expect(polygonOrder(LEVEL)).toEqual([
      LEVEL.lIndex,
      LEVEL.rIndex,
      LEVEL.rThumb,
      LEVEL.lThumb,
    ]);
  });

  it('is a simple convex quad when the hands are level', () => {
    const pts = polygonOrder(LEVEL);
    expect(selfIntersects(pts)).toBe(false);
    expect(polygonArea(pts)).toBeCloseTo(200 * 200);
  });

  it('self-intersects into a bowtie when one hand rotates', () => {
    const pts = polygonOrder(ROTATED);
    expect(selfIntersects(pts)).toBe(true);
  });

  it('bowtie lobes cancel under the shoelace formula', () => {
    // Why `area` is a weak signal for a rotated hand and `gap` is the primary
    // trigger input — the two triangles have opposite winding.
    expect(polygonArea(polygonOrder(ROTATED))).toBeCloseTo(0);
  });
});

describe('normalised signals', () => {
  it('gap is invariant to camera distance', () => {
    const far: PortalPoints = {
      lIndex: { x: 50, y: 50 },
      rIndex: { x: 150, y: 50 },
      rThumb: { x: 150, y: 150 },
      lThumb: { x: 50, y: 150 },
      handSize: 50,
    };
    // `far` is `LEVEL` at half scale: same normalised gap.
    expect(normalizedGap(far)).toBeCloseTo(normalizedGap(LEVEL));
  });

  it('gap is the mean of the index and thumb separations over hand size', () => {
    expect(normalizedGap(LEVEL)).toBeCloseTo(200 / 100);
  });
});

describe('EMA smoothing', () => {
  it('snaps to the first observation when there is no history', () => {
    expect(smoothPortal(null, LEVEL, 0.5)).toEqual(LEVEL);
  });

  it('moves halfway toward the target at alpha 0.5', () => {
    const next: PortalPoints = { ...LEVEL, lIndex: { x: 200, y: 100 } };
    expect(smoothPortal(LEVEL, next, 0.5).lIndex.x).toBeCloseTo(150);
  });

  it('is a no-op at alpha 1', () => {
    const next: PortalPoints = { ...LEVEL, lIndex: { x: 200, y: 100 } };
    expect(smoothPortal(LEVEL, next, 1)).toEqual(next);
  });

  it('converges rather than oscillating on a noisy stream', () => {
    let s: PortalPoints | null = null;
    for (let i = 0; i < 60; i++) {
      const noisy: PortalPoints = {
        ...LEVEL,
        lIndex: { x: 100 + (i % 2 ? 10 : -10), y: 100 },
      };
      s = smoothPortal(s, noisy, 0.5);
    }
    expect(Math.abs(s!.lIndex.x - 100)).toBeLessThan(5);
  });
});
