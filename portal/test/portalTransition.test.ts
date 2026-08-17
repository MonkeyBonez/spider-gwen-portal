/**
 * Switch transition (PRD §4.1).
 *
 * The load-bearing property is that moving the dimension swap from "when the
 * trigger fires" to "when the portal is fully shut" does not change *how many*
 * swaps happen — the Phase 0 exit criterion still has to hold.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config';
import {
  GesturalTransition,
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
  maxHoldMs: DEFAULT_CONFIG.maxHoldMs,
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

  it('iris collapses every point onto the centre', () => {
    const shaped = applyTransition(PORTAL, collapsed, 'iris');
    expect(shaped.lIndex).toEqual(shaped.rThumb);
    expect(shaped.lIndex.x).toBeCloseTo(200);
    expect(shaped.lIndex.y).toBeCloseTo(200);
  });

  it('is shortlisted to none/iris/shutter/twist', () => {
    expect(TRANSITION_KINDS).toEqual(['none', 'iris', 'shutter', 'twist']);
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

describe('GesturalTransition (PRD §4.1)', () => {
  /** Run frames at 60fps from `from` to `to`, collecting the states. */
  function run(g: GesturalTransition, from: number, to: number, spec = SPEC) {
    const states = [];
    for (let t = from; t <= to; t += 16) states.push({ t, ...g.update(t, spec) });
    return states;
  }

  it('holds shut indefinitely until released', () => {
    const g = new GesturalTransition();
    g.collapse(0);
    // Ten seconds — far past any holdMs — with maxHold disabled.
    const spec = { ...SPEC, maxHoldMs: 0 };
    const states = run(g, 0, 10_000, spec);
    const last = states.at(-1)!;
    expect(last.phase).toBe('hold');
    expect(last.closure).toBe(0);
  });

  it('the timed version would have reopened in that same window', () => {
    // The contrast that motivates the gestural timing: a fixed hold cannot know
    // the hands are still shut.
    const timed = new PortalTransition();
    timed.trigger(0);
    const end = SPEC.collapseMs + SPEC.holdMs + SPEC.reopenMs;
    expect(timed.update(end + 16, SPEC).phase).toBe('idle');
  });

  it('reopens only once released, and lands fully open', () => {
    const g = new GesturalTransition();
    g.collapse(0);
    run(g, 0, 1000, { ...SPEC, maxHoldMs: 0 });
    g.release(1000);
    const states = run(g, 1000, 1000 + SPEC.reopenMs + 64, { ...SPEC, maxHoldMs: 0 });
    expect(states.some((s) => s.phase === 'reopen')).toBe(true);
    expect(states.at(-1)!.phase).toBe('idle');
    expect(states.at(-1)!.closure).toBe(1);
  });

  it('swaps exactly once per collapse→release cycle', () => {
    const g = new GesturalTransition();
    let swaps = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      const base = cycle * 2000;
      g.collapse(base);
      for (const s of run(g, base, base + 900, { ...SPEC, maxHoldMs: 0 })) {
        if (s.swap) swaps++;
      }
      g.release(base + 900);
      for (const s of run(g, base + 900, base + 1900, { ...SPEC, maxHoldMs: 0 })) {
        if (s.swap) swaps++;
      }
    }
    expect(swaps).toBe(20);
  });

  it('swaps at zero closure, so the change is always masked', () => {
    const g = new GesturalTransition();
    g.collapse(0);
    const swapFrame = run(g, 0, 900, { ...SPEC, maxHoldMs: 0 }).find((s) => s.swap)!;
    expect(swapFrame).toBeDefined();
    expect(swapFrame.closure).toBe(0);
  });

  it('still swaps when released before the collapse finishes', () => {
    // A flick too fast to fully close must not silently skip the dimension.
    const g = new GesturalTransition();
    g.collapse(0);
    g.update(16, SPEC); // mid-collapse
    g.release(16);
    const states = run(g, 16, 16 + SPEC.reopenMs + 64);
    expect(states.filter((s) => s.swap)).toHaveLength(1);
  });

  it('reopens itself if the release never arrives, when a cap is set', () => {
    const spec = { ...SPEC, maxHoldMs: 2000 };
    const g = new GesturalTransition();
    g.collapse(0);
    const states = run(g, 0, spec.maxHoldMs + spec.reopenMs + 200, spec);
    expect(states.at(-1)!.phase).toBe('idle');
  });

  it('has that cap off by default, so a held-shut portal never self-opens', () => {
    // Holding the gesture closed is a performance choice, not a fault — a timer
    // here would reopen the portal with the hands still visibly together.
    expect(DEFAULT_CONFIG.maxHoldMs).toBe(0);
    const g = new GesturalTransition();
    g.collapse(0);
    expect(run(g, 0, 30_000, SPEC).at(-1)!.phase).toBe('hold');
  });

  it('a release with nothing collapsed is ignored', () => {
    const g = new GesturalTransition();
    g.release(0);
    expect(g.update(16, SPEC).phase).toBe('idle');
    expect(g.active).toBe(false);
  });

  it('re-collapsing mid-reopen is continuous, not a jump back to 1', () => {
    // Overshoot off, so closure stays within [0,1] and "partly open" is
    // unambiguous — easeOutBack legitimately exceeds 1 mid-reopen otherwise.
    const spec = { ...SPEC, maxHoldMs: 0, overshoot: 0 };
    const g = new GesturalTransition();
    g.collapse(0);
    run(g, 0, 300, spec);
    g.release(300);
    const mid = g.update(300 + spec.reopenMs / 2, spec);
    expect(mid.closure).toBeGreaterThan(0);
    expect(mid.closure).toBeLessThan(1);
    g.collapse(300 + spec.reopenMs / 2);
    // Collapse resumes from where the reopen got to, not from fully open.
    const next = g.update(300 + spec.reopenMs / 2 + 1, spec);
    expect(next.closure).toBeLessThanOrEqual(mid.closure + 1e-9);
  });

  it('kind `none` collapses and reopens instantly', () => {
    const g = new GesturalTransition();
    const spec = { ...SPEC, kind: 'none' as const, maxHoldMs: 0 };
    g.collapse(0);
    const shut = g.update(0, spec);
    expect(shut.closure).toBe(0);
    expect(shut.swap).toBe(true);
    g.release(100);
    expect(g.update(100, spec).phase).toBe('idle');
  });
});

describe('maxHoldMs migration', () => {
  // vitest runs in node, which has no localStorage. Minimal stub — `loadConfig`
  // only ever calls getItem, and the tests clear between cases.
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;

  it('treats a persisted legacy 2000 as unset', () => {
    // The old default reopened the portal on a timer with the hands still shut.
    localStorage.setItem(
      'portal.config.v2',
      JSON.stringify({ ...DEFAULT_CONFIG, maxHoldMs: 2000, closeThreshold: 0.42 }),
    );
    const cfg = loadConfig();
    expect(cfg.maxHoldMs).toBe(0);
    // …without discarding anything actually tuned.
    expect(cfg.closeThreshold).toBe(0.42);
    localStorage.clear();
  });

  it('keeps a deliberately chosen cap', () => {
    localStorage.setItem(
      'portal.config.v2',
      JSON.stringify({ ...DEFAULT_CONFIG, maxHoldMs: 5000 }),
    );
    expect(loadConfig().maxHoldMs).toBe(5000);
    localStorage.clear();
  });
});
