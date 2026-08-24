import { describe, expect, it } from 'vitest';
import { BASE_L_POSE, fitPose, outlinePair } from '../src/tutorialPose';
import { LM, dist } from '../src/geometry';

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('base pose', () => {
  it('has all 21 MediaPipe landmarks', () => {
    expect(BASE_L_POSE).toHaveLength(21);
  });

  it('defines the hand-size unit: wrist to middle MCP is exactly 1', () => {
    // Everything downstream reads scale in hand sizes, matching HandPoints.size.
    near(dist(BASE_L_POSE[LM.WRIST], BASE_L_POSE[LM.MIDDLE_MCP]), 1);
  });

  it('makes an L: index and thumb spread well apart', () => {
    const spread = dist(BASE_L_POSE[LM.INDEX_TIP], BASE_L_POSE[LM.THUMB_TIP]);
    expect(spread).toBeGreaterThan(1.5);
  });

  it('curls the last three fingers back toward the palm', () => {
    // A curled fingertip sits nearer the wrist than its own PIP joint.
    for (const [pip, tip] of [[10, 12], [14, 16], [18, 20]]) {
      const tipReach = dist(BASE_L_POSE[LM.WRIST], BASE_L_POSE[tip]);
      const pipReach = dist(BASE_L_POSE[LM.WRIST], BASE_L_POSE[pip]);
      expect(tipReach).toBeLessThan(pipReach);
    }
  });
});

describe('fitPose', () => {
  const indexTarget = { x: 400, y: 200 };
  const thumbTarget = { x: 400, y: 500 };

  it('lands both fingertips exactly on their targets', () => {
    // The whole point: the guide's tips ARE the portal corners, to the pixel.
    const out = fitPose(BASE_L_POSE, indexTarget, thumbTarget);
    near(out.indexTip.x, indexTarget.x, 1e-6);
    near(out.indexTip.y, indexTarget.y, 1e-6);
    near(out.thumbTip.x, thumbTarget.x, 1e-6);
    near(out.thumbTip.y, thumbTarget.y, 1e-6);
  });

  it('is a similarity transform: every pairwise distance scales by one factor', () => {
    const out = fitPose(BASE_L_POSE, indexTarget, thumbTarget);
    const k = dist(out.points[0], out.points[9]) / dist(BASE_L_POSE[0], BASE_L_POSE[9]);
    for (const [a, b] of [[0, 4], [5, 8], [9, 17], [4, 8]]) {
      near(dist(out.points[a], out.points[b]) / dist(BASE_L_POSE[a], BASE_L_POSE[b]), k, 1e-6);
    }
  });

  it('reports handSize consistent with that scale factor', () => {
    const out = fitPose(BASE_L_POSE, indexTarget, thumbTarget);
    near(out.handSize, dist(out.points[LM.WRIST], out.points[LM.MIDDLE_MCP]), 1e-9);
  });

  it('scales with the span between the targets', () => {
    const small = fitPose(BASE_L_POSE, { x: 0, y: 0 }, { x: 0, y: 100 });
    const big = fitPose(BASE_L_POSE, { x: 0, y: 0 }, { x: 0, y: 300 });
    near(big.handSize / small.handSize, 3, 1e-6);
  });

  it('rejects a degenerate pose rather than emitting NaN', () => {
    const flat = BASE_L_POSE.map(() => ({ x: 1, y: 1 }));
    expect(() => fitPose(flat, indexTarget, thumbTarget)).toThrow(/coincident/);
  });
});

describe('outlinePair', () => {
  const W = 1280;
  const H = 720;

  it('puts index tips above thumb tips, left hand left of right hand', () => {
    const pair = outlinePair(W, H, 0.1, 0.15);
    expect(pair.left.indexTip.y).toBeLessThan(pair.left.thumbTip.y);
    expect(pair.right.indexTip.y).toBeLessThan(pair.right.thumbTip.y);
    expect(pair.left.indexTip.x).toBeLessThan(pair.right.indexTip.x);
  });

  it('frames a portal centred in the canvas', () => {
    const pair = outlinePair(W, H, 0.1, 0.15);
    near((pair.left.indexTip.x + pair.right.indexTip.x) / 2, W / 2, 1e-6);
    near((pair.left.indexTip.y + pair.left.thumbTip.y) / 2, H / 2, 1e-6);
  });

  it('keeps each hand body outside the portal it frames', () => {
    // Chirality check. If a pose were mirrored the wrong way the palm would sit
    // inside the window, telling people to cover the very thing they're opening.
    const pair = outlinePair(W, H, 0.1, 0.15);
    expect(pair.left.points[LM.WRIST].x).toBeLessThan(pair.left.indexTip.x);
    expect(pair.right.points[LM.WRIST].x).toBeGreaterThan(pair.right.indexTip.x);
  });

  it('spreads the hands further apart as the width grows, at constant size', () => {
    const nearPair = outlinePair(W, H, 0.07, 0.15);
    const farPair = outlinePair(W, H, 0.21, 0.15);
    const nearGap = farPair.right.indexTip.x - farPair.left.indexTip.x;
    const oldGap = nearPair.right.indexTip.x - nearPair.left.indexTip.x;
    expect(nearGap).toBeGreaterThan(oldGap);
    // Step 2 moves the hands, it does not resize them — the outline stays a
    // target the same pair of hands can still fill.
    near(farPair.left.handSize, nearPair.left.handSize, 1e-6);
  });

  it('scales the guides with the canvas', () => {
    const small = outlinePair(640, 360, 0.1, 0.15);
    const big = outlinePair(1280, 720, 0.1, 0.15);
    near(big.left.handSize / small.left.handSize, 2, 1e-6);
  });
});

