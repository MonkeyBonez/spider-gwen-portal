/**
 * Switch transition (PRD §4.1).
 *
 * The load-bearing property is that moving the dimension swap from "when the
 * trigger fires" to "when the portal is fully shut" does not change *how many*
 * swaps happen — the Phase 0 exit criterion still has to hold.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import {
  PortalTransition,
  TRANSITION_BLURBS,
  TRANSITION_KINDS,
  applyTransition,
  type TransitionSpec,
} from '../src/portalTransition';
import { polygonArea, polygonOrder, type PortalPoints } from '../src/geometry';

const SPEC: TransitionSpec = {
  kind: 'shutter',
  collapseMs: DEFAULT_CONFIG.collapseMs,
  holdMs: DEFAULT_CONFIG.holdMs,
  reopenMs: DEFAULT_CONFIG.reopenMs,
  overshoot: DEFAULT_CONFIG.reopenOvershoot,
  twistDegrees: DEFAULT_CONFIG.twistDegrees,
};

const PORTAL: PortalPoints = {
  lIndex: { x: 100, y: 100 },
  rIndex: { x: 300, y: 100 },
  rThumb: { x: 300, y: 300 },
  lThumb: { x: 100, y: 300 },
  handSize: 100,
};

/** Run a transition frame by frame at 60fps, collecting per-frame state. */
function play(spec: TransitionSpec, frames = 60, fps = 60) {
  const tr = new PortalTransition();
  const step = 1000 / fps;
  let t = 0;
  tr.trigger(t);
  const states = [];
  for (let i = 0; i < frames; i++) {
    t += step;
    states.push(tr.update(t, spec));
  }
  return states;
}

describe('PortalTransition timing', () => {
  it('swaps exactly once per trigger', () => {
    const swaps = play(SPEC).filter((s) => s.swap).length;
    expect(swaps).toBe(1);
  });

  it('swaps while the portal is fully shut, not while it is visible', () => {
    const states = play(SPEC);
    const swapFrame = states.find((s) => s.swap)!;
    expect(swapFrame.closure).toBe(0);
    expect(swapFrame.phase).toBe('hold');
  });

  it('swaps immediately when the transition is disabled', () => {
    const states = play({ ...SPEC, kind: 'none' });
    expect(states[0].swap).toBe(true);
    expect(states[0].phase).toBe('idle');
  });

  it('still swaps exactly once with a zero-length hold', () => {
    const swaps = play({ ...SPEC, holdMs: 0 }).filter((s) => s.swap).length;
    expect(swaps).toBe(1);
  });

  it('returns to idle at full closure once finished', () => {
    const last = play(SPEC, 120).at(-1)!;
    expect(last.phase).toBe('idle');
    expect(last.closure).toBe(1);
  });

  it('runs collapse → hold → reopen in order', () => {
    const phases = [...new Set(play(SPEC).map((s) => s.phase))];
    expect(phases).toEqual(['collapse', 'hold', 'reopen', 'idle']);
  });

  it('re-triggering mid-flight restarts cleanly and still swaps once more', () => {
    const tr = new PortalTransition();
    let t = 0;
    let swaps = 0;
    tr.trigger(t);
    for (let i = 0; i < 3; i++) {
      t += 16;
      if (tr.update(t, SPEC).swap) swaps++;
    }
    tr.trigger(t); // interrupt before the first one reached its hold
    for (let i = 0; i < 60; i++) {
      t += 16;
      if (tr.update(t, SPEC).swap) swaps++;
    }
    expect(swaps).toBe(1);
  });

  it('does not swap again after finishing', () => {
    const tr = new PortalTransition();
    let t = 0;
    tr.trigger(t);
    let swaps = 0;
    for (let i = 0; i < 200; i++) {
      t += 16;
      if (tr.update(t, SPEC).swap) swaps++;
    }
    expect(swaps).toBe(1);
  });

  it('overshoots past the fingertips when overshoot is on', () => {
    const max = Math.max(...play({ ...SPEC, overshoot: 1.7 }).map((s) => s.closure));
    expect(max).toBeGreaterThan(1);
  });

  it('never overshoots when overshoot is zero', () => {
    const max = Math.max(...play({ ...SPEC, overshoot: 0 }).map((s) => s.closure));
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('applyTransition geometry', () => {
  const collapsed = { phase: 'hold' as const, closure: 0, twist: 0, swap: false };
  const open = { phase: 'idle' as const, closure: 1, twist: 0, swap: false };

  it('is a no-op when idle', () => {
    expect(applyTransition(PORTAL, open, 'iris')).toBe(PORTAL);
  });

  it('is a no-op for kind "none" even mid-flight', () => {
    expect(applyTransition(PORTAL, collapsed, 'none')).toBe(PORTAL);
  });

  for (const kind of TRANSITION_KINDS.filter((k) => k !== 'none')) {
    it(`collapses "${kind}" to zero visible area`, () => {
      const shaped = applyTransition(PORTAL, collapsed, kind);
      expect(polygonArea(polygonOrder(shaped))).toBeCloseTo(0);
    });

    it(`restores "${kind}" exactly to the live fingertips at closure 1`, () => {
      const shaped = applyTransition(PORTAL, { ...open, phase: 'reopen' }, kind);
      expect(shaped.lIndex.x).toBeCloseTo(PORTAL.lIndex.x);
      expect(shaped.rThumb.y).toBeCloseTo(PORTAL.rThumb.y);
    });

    it(`has a pitch blurb for "${kind}"`, () => {
      expect(TRANSITION_BLURBS[kind].length).toBeGreaterThan(10);
    });
  }

  it('shutter collapses horizontally, keeping the vertical extent', () => {
    const shaped = applyTransition(PORTAL, collapsed, 'shutter');
    expect(shaped.lIndex.x).toBeCloseTo(shaped.rIndex.x); // squeezed to the midline
    expect(shaped.lIndex.y).toBeCloseTo(PORTAL.lIndex.y); // heights untouched
    expect(shaped.lThumb.y).toBeCloseTo(PORTAL.lThumb.y);
  });

  it('eyelid drops the index tips onto the thumbs and holds the thumb line', () => {
    const shaped = applyTransition(PORTAL, collapsed, 'eyelid');
    expect(shaped.lIndex).toEqual(PORTAL.lThumb);
    expect(shaped.lThumb).toEqual(PORTAL.lThumb);
  });

  it('wipe collapses onto the right-hand edge', () => {
    const shaped = applyTransition(PORTAL, collapsed, 'wipe');
    expect(shaped.lIndex.x).toBeCloseTo(PORTAL.rIndex.x);
    expect(shaped.rIndex.x).toBeCloseTo(PORTAL.rIndex.x);
  });

  it('twist rotates the portal while it is partly open', () => {
    const shaped = applyTransition(
      PORTAL,
      { phase: 'reopen', closure: 0.5, twist: Math.PI / 2, swap: false },
      'twist',
    );
    // lIndex (100,100) halfway to the centre (200,200) is (150,150), i.e. an
    // offset of (-50,-50). A 90° rotation maps (dx,dy) → (-dy,dx) = (50,-50).
    expect(shaped.lIndex.x).toBeCloseTo(250);
    expect(shaped.lIndex.y).toBeCloseTo(150);
  });

  it('leaves handSize alone so normalised signals stay meaningful', () => {
    expect(applyTransition(PORTAL, collapsed, 'iris').handSize).toBe(PORTAL.handSize);
  });
});
