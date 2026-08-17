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
  CONTACT_BLURBS,
  CONTACT_MODES,
  allPairDistances,
  blendSpread,
  DEFAULT_WORST_SIDE_BIAS,
  blendSides,
  normalizedGap,
  polygonArea,
  polygonOrder,
  sideGaps,
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

  it('gap is the side separation over hand size', () => {
    // LEVEL is symmetric (both sides 200px), so this holds at any worst-side bias.
    expect(normalizedGap(LEVEL, 'strict')).toBeCloseTo(200 / 100);
  });
});

/** The ladder shown in /closure.html, reused as the test sweep. */
const BIASES = [0, 0.25, 0.5, 0.75, 1];

describe('contact modes (PRD §2.2.1)', () => {
  /**
   * The case that motivated this: the left hand is rotated so its index meets
   * the *right thumb* and its thumb meets the right index. The hands are shut,
   * but index↔index and thumb↔thumb are both still far apart.
   */
  const CROSSED_SHUT: PortalPoints = {
    lIndex: { x: 99, y: 200 }, // touching rThumb
    rIndex: { x: 100, y: 100 },
    rThumb: { x: 101, y: 200 },
    lThumb: { x: 100, y: 99 }, // touching rIndex
    handSize: 100,
  };

  it('strict mode misses a crossed close — the bug being fixed', () => {
    expect(normalizedGap(CROSSED_SHUT, 'strict')).toBeGreaterThan(0.5);
  });

  it('paired mode sees the crossed close', () => {
    expect(normalizedGap(CROSSED_SHUT, 'paired')).toBeLessThan(0.05);
  });

  it('any mode sees the crossed close', () => {
    expect(normalizedGap(CROSSED_SHUT, 'any')).toBeLessThan(0.05);
  });

  it('every mode agrees the portal is shut when all four points meet', () => {
    const shut: PortalPoints = {
      lIndex: { x: 100, y: 100 },
      rIndex: { x: 101, y: 100 },
      rThumb: { x: 101, y: 101 },
      lThumb: { x: 100, y: 101 },
      handSize: 100,
    };
    for (const mode of CONTACT_MODES) {
      expect(normalizedGap(shut, mode)).toBeLessThan(0.05);
    }
  });

  /**
   * The hinge: thumbs stay pressed together as a pivot while the index fingers
   * swing wide open — a plausible way to perform the gesture. `any` reports this
   * as shut, so the state machine would never see an open and would stop firing.
   * `paired` correctly reports it as open. This is why `paired` is the default.
   */
  const THUMB_HINGE_OPEN: PortalPoints = {
    lIndex: { x: 20, y: 20 },
    rIndex: { x: 280, y: 20 },
    rThumb: { x: 151, y: 200 },
    lThumb: { x: 150, y: 200 }, // thumbs still touching
    handSize: 100,
  };

  it('any mode reads a wide thumb-pivot hinge as shut — the documented caveat', () => {
    expect(normalizedGap(THUMB_HINGE_OPEN, 'any')).toBeLessThan(0.05);
  });

  it('paired mode correctly reads the thumb-pivot hinge as open', () => {
    expect(normalizedGap(THUMB_HINGE_OPEN, 'paired')).toBeGreaterThan(0.5);
  });

  it('paired never reports more than strict, at any bias', () => {
    // It takes the better of two pairings, one of which is strict's.
    for (const p of [LEVEL, ROTATED, CROSSED_SHUT, THUMB_HINGE_OPEN]) {
      for (const bias of BIASES) {
        expect(normalizedGap(p, 'paired', bias)).toBeLessThanOrEqual(
          normalizedGap(p, 'strict', bias) + 1e-9,
        );
      }
    }
  });

  it('any never reports more than paired, at any bias', () => {
    // `any` is a min over all four cross-hand pairs, so it cannot exceed a blend
    // of any two of them however the bias weights them.
    for (const p of [LEVEL, ROTATED, CROSSED_SHUT, THUMB_HINGE_OPEN]) {
      for (const bias of BIASES) {
        expect(normalizedGap(p, 'any', bias)).toBeLessThanOrEqual(
          normalizedGap(p, 'paired', bias) + 1e-9,
        );
      }
    }
  });

  it('ignores same-hand contact', () => {
    // A pinched left hand (own index touching own thumb) with the hands far
    // apart must not read as closed in any mode.
    const pinchedButApart: PortalPoints = {
      lIndex: { x: 20, y: 100 },
      lThumb: { x: 21, y: 100 },
      rIndex: { x: 400, y: 100 },
      rThumb: { x: 401, y: 100 },
      handSize: 100,
    };
    for (const mode of CONTACT_MODES) {
      expect(normalizedGap(pinchedButApart, mode)).toBeGreaterThan(1);
    }
  });

  it('has a blurb for every mode', () => {
    for (const mode of CONTACT_MODES) {
      expect(CONTACT_BLURBS[mode].length).toBeGreaterThan(10);
    }
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

describe('worst-side bias (PRD §2.2.1)', () => {
  /**
   * The reported bug: index fingers 0.6 hand-widths apart while the thumbs
   * touch. A plain mean averages that to 0.30 — under the 0.35 close threshold —
   * so the trigger latches CLOSED on a portal that is plainly a wide triangle.
   */
  const WIDE_INDEX_THUMBS_SHUT: PortalPoints = {
    lIndex: { x: 100, y: 100 },
    rIndex: { x: 160, y: 100 }, // 60px apart = 0.60 hand-widths
    rThumb: { x: 130.5, y: 200 },
    lThumb: { x: 130, y: 200 }, // touching
    handSize: 100,
  };

  /** A rotated-hand close, where the crossed pairing is the shut one. */
  const CROSSED_SHUT: PortalPoints = {
    lIndex: { x: 99, y: 200 },
    rIndex: { x: 100, y: 100 },
    rThumb: { x: 101, y: 200 },
    lThumb: { x: 100, y: 99 },
    handSize: 100,
  };

  const CLOSE_THRESHOLD = 0.35; // DEFAULT_CONFIG.closeThreshold

  it('averaging the sides fires the close on a plainly open portal', () => {
    for (const mode of ['strict', 'paired'] as const) {
      expect(normalizedGap(WIDE_INDEX_THUMBS_SHUT, mode, 0)).toBeLessThan(CLOSE_THRESHOLD);
    }
  });

  it('the default bias rejects it', () => {
    for (const mode of ['strict', 'paired'] as const) {
      expect(
        normalizedGap(WIDE_INDEX_THUMBS_SHUT, mode, DEFAULT_WORST_SIDE_BIAS),
      ).toBeGreaterThan(CLOSE_THRESHOLD);
    }
  });

  it('bias 0 is exactly the mean and bias 1 is exactly the max', () => {
    for (const [a, b] of [
      [0.6, 0],
      [0.4, 0.2],
      [1, 1],
      [0, 0],
    ]) {
      expect(blendSides(a, b, 0)).toBeCloseTo((a + b) / 2, 10);
      expect(blendSides(a, b, 1)).toBeCloseTo(Math.max(a, b), 10);
    }
  });

  it('is symmetric in its two arguments', () => {
    for (const bias of BIASES) {
      expect(blendSides(0.6, 0.1, bias)).toBeCloseTo(blendSides(0.1, 0.6, bias), 10);
    }
  });

  /**
   * The property that makes the bias safe to change without retuning the
   * close/open thresholds: when both sides agree, mean === max === that value.
   */
  it('leaves symmetric poses untouched at every bias', () => {
    for (const p of [LEVEL, ROTATED]) {
      const readings = BIASES.map((bias) => normalizedGap(p, 'strict', bias));
      for (const r of readings) expect(r).toBeCloseTo(readings[0], 10);
    }
  });

  it('is monotonically non-decreasing in bias for a lopsided pose', () => {
    const readings = BIASES.map((b) => normalizedGap(WIDE_INDEX_THUMBS_SHUT, 'strict', b));
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThanOrEqual(readings[i - 1] - 1e-9);
    }
    // And it actually moves — a flat sweep would pass the check above vacuously.
    expect(readings.at(-1)!).toBeGreaterThan(readings[0] + 0.1);
  });

  it('clamps a bias outside [0,1] rather than extrapolating past the max', () => {
    expect(blendSides(0.6, 0, -5)).toBeCloseTo(0.3, 10);
    expect(blendSides(0.6, 0, 99)).toBeCloseTo(0.6, 10);
  });

  it('does not affect `any`, which has no two sides to weigh', () => {
    for (const p of [LEVEL, CROSSED_SHUT, WIDE_INDEX_THUMBS_SHUT]) {
      const readings = BIASES.map((bias) => normalizedGap(p, 'any', bias));
      for (const r of readings) expect(r).toBeCloseTo(readings[0], 10);
    }
  });

  it('sideGaps reports the two sides behind the gap', () => {
    const s = sideGaps(WIDE_INDEX_THUMBS_SHUT, 'strict');
    expect(s.a).toBeCloseTo(0.6, 6);
    expect(s.b).toBeCloseTo(0.005, 6);
    // And the winning pairing's blend is what `normalizedGap` returned.
    expect(blendSides(s.a, s.b, DEFAULT_WORST_SIDE_BIAS)).toBeCloseTo(
      normalizedGap(WIDE_INDEX_THUMBS_SHUT, 'strict', DEFAULT_WORST_SIDE_BIAS),
      6,
    );
  });

  it('sideGaps follows paired mode to the crossed pairing when it wins', () => {
    const s = sideGaps(CROSSED_SHUT, 'paired');
    expect(blendSides(s.a, s.b, DEFAULT_WORST_SIDE_BIAS)).toBeCloseTo(
      normalizedGap(CROSSED_SHUT, 'paired', DEFAULT_WORST_SIDE_BIAS),
      6,
    );
    // The crossed pairing is the shut one, so both its sides are near zero.
    expect(Math.max(s.a, s.b)).toBeLessThan(0.05);
  });

  it('still reads a genuine four-point close as shut at every bias', () => {
    const shut: PortalPoints = {
      lIndex: { x: 100, y: 100 },
      rIndex: { x: 101, y: 100 },
      rThumb: { x: 101, y: 101 },
      lThumb: { x: 100, y: 101 },
      handSize: 100,
    };
    for (const bias of BIASES) {
      for (const mode of CONTACT_MODES) {
        expect(normalizedGap(shut, mode, bias)).toBeLessThan(CLOSE_THRESHOLD);
      }
    }
  });
});

describe('all-four-points contact mode (PRD §2.2.1)', () => {
  const CLOSE_T = 0.5; // DEFAULT_CONFIG.closeThreshold, on the `all` scale

  /**
   * The slit: hands flattened together. Index pair touching, thumb pair touching,
   * so both *sides* are shut — but the index pair is still a thumb-span from the
   * thumb pair. `paired` calls this closed; `all` calls it open, because the four
   * points have not converged. This is the entire difference between `all` and
   * worst-side bias 1.
   */
  const SLIT: PortalPoints = {
    lIndex: { x: 100, y: 100 },
    rIndex: { x: 101, y: 100 },
    rThumb: { x: 101, y: 190 },
    lThumb: { x: 100, y: 190 },
    handSize: 100,
  };

  /** All four fingertips converged on one another. */
  const CONVERGED: PortalPoints = {
    lIndex: { x: 100, y: 100 },
    rIndex: { x: 108, y: 101 },
    rThumb: { x: 106, y: 108 },
    lThumb: { x: 99, y: 107 },
    handSize: 100,
  };

  it('paired reads the slit as shut even at bias 1 — what `all` is for', () => {
    expect(normalizedGap(SLIT, 'paired', 1)).toBeLessThan(CLOSE_T);
  });

  it('all reads the slit as open', () => {
    expect(normalizedGap(SLIT, 'all', 1)).toBeGreaterThan(CLOSE_T);
  });

  it('all reads four converged fingertips as shut', () => {
    expect(normalizedGap(CONVERGED, 'all', 1)).toBeLessThan(CLOSE_T);
  });

  it('at bias 1 it is exactly the diameter of the four points', () => {
    for (const p of [LEVEL, ROTATED, SLIT, CONVERGED]) {
      const diameter = Math.max(...allPairDistances(p)) / p.handSize;
      expect(normalizedGap(p, 'all', 1)).toBeCloseTo(diameter, 10);
    }
  });

  it('includes same-hand pairs, unlike every other mode', () => {
    // lIndex↔lThumb is 90px here and is the widest pair, so it must dominate.
    const widest = allPairDistances(SLIT);
    expect(Math.max(...widest)).toBeGreaterThan(89);
  });

  it('a lone same-hand pinch with the hands apart still reads wide open', () => {
    // Including same-hand distance can only make `all` stricter, never invent a close.
    const pinchedButApart: PortalPoints = {
      lIndex: { x: 20, y: 100 },
      lThumb: { x: 21, y: 100 },
      rIndex: { x: 400, y: 100 },
      rThumb: { x: 401, y: 100 },
      handSize: 100,
    };
    for (const bias of BIASES) {
      expect(normalizedGap(pinchedButApart, 'all', bias)).toBeGreaterThan(1);
    }
  });

  it('is never more permissive than strict at bias 1', () => {
    // The diameter is a max over all six pairs; strict's two are among them.
    for (const p of [LEVEL, ROTATED, SLIT, CONVERGED]) {
      expect(normalizedGap(p, 'all', 1)).toBeGreaterThanOrEqual(
        normalizedGap(p, 'strict', 1) - 1e-9,
      );
    }
  });

  it('blendSpread matches blendSides for two values', () => {
    for (const bias of BIASES) {
      expect(blendSpread([0.6, 0.1], bias)).toBeCloseTo(blendSides(0.6, 0.1, bias), 10);
    }
  });

  it('blendSpread is mean at bias 0 and max at bias 1', () => {
    const v = [0.2, 0.5, 0.9, 0.1];
    expect(blendSpread(v, 0)).toBeCloseTo(0.425, 10);
    expect(blendSpread(v, 1)).toBeCloseTo(0.9, 10);
  });

  it('sideGaps reports the widest and narrowest pair for `all`', () => {
    const s = sideGaps(SLIT, 'all');
    const all = allPairDistances(SLIT).map((d) => d / SLIT.handSize);
    expect(s.a).toBeCloseTo(Math.max(...all), 10);
    expect(s.b).toBeCloseTo(Math.min(...all), 10);
  });
});
