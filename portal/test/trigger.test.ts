/**
 * Phase 0 exit criterion (PRD §4): "colour reliably switches exactly once per
 * close→open cycle across ~20 consecutive cycles".
 *
 * Driven by a synthetic gap signal at 30fps rather than a camera, so the state
 * machine can be regression-tested without hands in front of a webcam.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config';
import { CloseOpenTrigger } from '../src/triggers/closeOpenTrigger';
import type { GestureTrigger, TriggerSignals } from '../src/triggers/types';

const FPS = 30;
const DT = 1 / FPS;

interface RunOptions {
  cfg?: Partial<Config>;
  /** Per-frame gap noise amplitude. */
  noise?: number;
  /** Frames where tracking drops out entirely. */
  dropoutFrames?: Set<number>;
}

/** Deterministic PRNG so a "noisy" test never flakes. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
}

/**
 * Build a gap trace: `cycles` repetitions of open → close → hold → open,
 * each phase ramped linearly like a real hand movement.
 */
function gapTrace(cycles: number, opts: { openGap?: number; closedGap?: number } = {}): number[] {
  const openGap = opts.openGap ?? 1.2;
  const closedGap = opts.closedGap ?? 0.08;
  const ramp = (from: number, to: number, frames: number) =>
    Array.from({ length: frames }, (_, i) => from + ((to - from) * (i + 1)) / frames);

  const trace: number[] = Array.from({ length: 10 }, () => openGap);
  for (let c = 0; c < cycles; c++) {
    trace.push(...ramp(openGap, closedGap, 6)); // closing, ~200ms
    trace.push(...Array.from({ length: 8 }, () => closedGap)); // held shut, ~270ms
    trace.push(...ramp(closedGap, openGap, 6)); // opening, ~200ms
    trace.push(...Array.from({ length: 12 }, () => openGap)); // held open, ~400ms
  }
  return trace;
}

function run(trigger: GestureTrigger, trace: number[], opts: RunOptions = {}) {
  const cfg: Config = { ...DEFAULT_CONFIG, ...opts.cfg };
  const noise = rng(42);
  let prevGap = trace[0];
  let velocity = 0;
  let t = 0;
  let advances = 0;
  const states = new Set<string>();

  trace.forEach((base, i) => {
    t += DT * 1000;
    const handsPresent = !opts.dropoutFrames?.has(i);
    const gap = base + (opts.noise ? noise() * opts.noise : 0);
    const instant = (gap - prevGap) / DT;
    velocity += (instant - velocity) * 0.35;
    prevGap = gap;

    const signals: TriggerSignals = {
      t,
      dt: DT,
      handsPresent,
      gap,
      area: gap * gap,
      gapVelocity: handsPresent ? velocity : 0,
    };
    const result = trigger.update(signals, cfg);
    states.add(result.state);
    if (result.advance) advances++;
  });

  return { advances, states };
}

/** The `gap` value on each frame where the trigger advanced. */
function advanceGaps(trigger: GestureTrigger, trace: number[]): number[] {
  const cfg: Config = { ...DEFAULT_CONFIG };
  let prevGap = trace[0];
  let velocity = 0;
  let t = 0;
  const gaps: number[] = [];

  for (const gap of trace) {
    t += DT * 1000;
    const instant = (gap - prevGap) / DT;
    velocity += (instant - velocity) * 0.35;
    prevGap = gap;
    const result = trigger.update(
      { t, dt: DT, handsPresent: true, gap, area: gap * gap, gapVelocity: velocity },
      cfg,
    );
    if (result.advance) gaps.push(gap);
  }
  return gaps;
}

describe('CloseOpenTrigger', () => {
  it('advances exactly once per close→open cycle over 20 cycles', () => {
    const { advances } = run(new CloseOpenTrigger(), gapTrace(20));
    expect(advances).toBe(20);
  });

  it('is unchanged by landmark noise', () => {
    const { advances } = run(new CloseOpenTrigger(), gapTrace(20), { noise: 0.04 });
    expect(advances).toBe(20);
  });

  it('fires while the portal is shut, never on the way back open', () => {
    // Every advance must land on a frame whose gap is below the close threshold,
    // so the swap is always masked (PRD §2.2).
    const trace = gapTrace(10);
    const gapsAtAdvance = advanceGaps(new CloseOpenTrigger(), trace);
    expect(gapsAtAdvance).toHaveLength(10);
    for (const gap of gapsAtAdvance) {
      expect(gap).toBeLessThan(DEFAULT_CONFIG.closeThreshold);
    }
  });

  it('visits every state in the machine', () => {
    const { states } = run(new CloseOpenTrigger(), gapTrace(3));
    expect(states).toContain('OPEN');
    expect(states).toContain('CLOSING');
    expect(states).toContain('CLOSED');
  });

  it('does not advance when hands never close', () => {
    const trace = Array.from({ length: 300 }, (_, i) => 1.0 + Math.sin(i / 8) * 0.3);
    const { advances } = run(new CloseOpenTrigger(), trace);
    expect(advances).toBe(0);
  });

  it('does not advance when hands stay shut', () => {
    // Static hands have zero velocity, so the close never latches: a gesture
    // requires actual movement, not merely being in the closed pose.
    const trace = Array.from({ length: 300 }, () => 0.05);
    const { advances } = run(new CloseOpenTrigger(), trace);
    expect(advances).toBe(0);
  });

  it('does not advance when the hands start shut and simply open', () => {
    // No preceding close movement, so opening alone is not a cycle.
    const trace = [
      ...Array.from({ length: 30 }, () => 0.05),
      ...Array.from({ length: 30 }, () => 1.2),
    ];
    const { advances } = run(new CloseOpenTrigger(), trace);
    expect(advances).toBe(0);
  });

  it('does not double-fire on jitter across the close threshold', () => {
    // Gap dithers right at the close threshold — the classic flapping case.
    const trace: number[] = [];
    for (let i = 0; i < 300; i++) {
      trace.push(DEFAULT_CONFIG.closeThreshold + (i % 2 === 0 ? -0.02 : 0.02));
    }
    const { advances } = run(new CloseOpenTrigger(), trace);
    // Never crosses the open threshold, so at most the initial latch fires.
    expect(advances).toBeLessThanOrEqual(1);
  });

  it('cooldown suppresses cycles faster than the configured minimum', () => {
    // 6-frame cycles = ~200ms apart, well inside the 500ms cooldown.
    const fast: number[] = [];
    for (let c = 0; c < 20; c++) {
      fast.push(0.05, 0.05, 0.05, 1.2, 1.2, 1.2);
    }
    const { advances } = run(new CloseOpenTrigger(), fast, { cfg: { velocityEpsilon: 0 } });
    expect(advances).toBeLessThan(20);
    expect(advances).toBeGreaterThan(0);
  });

  it('survives a brief tracking dropout while the hands are shut', () => {
    // Occlusion during the closed hold of each cycle must not lose the arm.
    const trace = gapTrace(10);
    const dropoutFrames = new Set<number>();
    for (let i = 0; i < trace.length; i++) {
      // frames 16..20 of each 32-frame cycle are inside the closed hold
      if (i > 10 && (i - 10) % 32 >= 8 && (i - 10) % 32 < 12) dropoutFrames.add(i);
    }
    const { advances } = run(new CloseOpenTrigger(), trace, { dropoutFrames });
    expect(advances).toBe(10);
  });

  it('resets after a long dropout rather than firing on reacquisition', () => {
    const trace = [...gapTrace(1), ...Array.from({ length: 120 }, () => 1.2)];
    const dropoutFrames = new Set<number>(
      Array.from({ length: 100 }, (_, i) => trace.length - 100 + i),
    );
    const { advances } = run(new CloseOpenTrigger(), trace, { dropoutFrames });
    expect(advances).toBe(1);
  });
});

describe('release event (gestural transition, PRD §4.1)', () => {
  /** Collect (advance, release) events with their frame index. */
  function events(trace: number[]) {
    const trigger = new CloseOpenTrigger();
    const cfg: Config = { ...DEFAULT_CONFIG };
    let prevGap = trace[0];
    let velocity = 0;
    let t = 0;
    const advances: number[] = [];
    const releases: number[] = [];

    trace.forEach((gap, i) => {
      t += DT * 1000;
      const instant = (gap - prevGap) / DT;
      velocity += (instant - velocity) * 0.35;
      prevGap = gap;
      const r = trigger.update(
        { t, dt: DT, handsPresent: true, gap, area: gap * gap, gapVelocity: velocity },
        cfg,
      );
      if (r.advance) advances.push(i);
      if (r.release) releases.push(i);
    });
    return { advances, releases };
  }

  it('fires exactly one release per close→open cycle', () => {
    const { advances, releases } = events(gapTrace(20));
    expect(advances).toHaveLength(20);
    expect(releases).toHaveLength(20);
  });

  it('every release comes after its own advance', () => {
    const { advances, releases } = events(gapTrace(10));
    for (let i = 0; i < 10; i++) {
      expect(releases[i]).toBeGreaterThan(advances[i]);
      // …and before the next cycle's advance, so the pairing is unambiguous.
      if (i + 1 < 10) expect(releases[i]).toBeLessThan(advances[i + 1]);
    }
  });

  it('does not release while the hands stay shut', () => {
    // Close and hold: the collapse fires, the reopen must not.
    const trace = [
      ...Array.from({ length: 10 }, () => 1.2),
      ...Array.from({ length: 6 }, (_, i) => 1.2 - (1.12 * (i + 1)) / 6),
      ...Array.from({ length: 200 }, () => 0.08), // held shut a long time
    ];
    const { advances, releases } = events(trace);
    expect(advances).toHaveLength(1);
    expect(releases).toHaveLength(0);
  });

  it('still releases when the hands snap open in a single frame', () => {
    // A fast open skips the OPENING state entirely; the release must survive it.
    const trace = [
      ...Array.from({ length: 10 }, () => 1.2),
      ...Array.from({ length: 6 }, (_, i) => 1.2 - (1.12 * (i + 1)) / 6),
      ...Array.from({ length: 6 }, () => 0.08),
      ...Array.from({ length: 20 }, () => 1.2), // instant jump back open
    ];
    const { advances, releases } = events(trace);
    expect(advances).toHaveLength(1);
    expect(releases).toHaveLength(1);
  });

  it('does not release without a preceding close', () => {
    const trace = [
      ...Array.from({ length: 30 }, () => 0.05),
      ...Array.from({ length: 30 }, () => 1.2),
    ];
    expect(events(trace).releases).toHaveLength(0);
  });
});

describe('releaseThreshold decouples the bloom from the close (PRD §4.1)', () => {
  /** Gap at each frame where `release` fired. */
  function releaseGaps(trace: number[], cfgOverride: Partial<Config> = {}): number[] {
    const trigger = new CloseOpenTrigger();
    const cfg: Config = { ...DEFAULT_CONFIG, ...cfgOverride };
    let prevGap = trace[0];
    let velocity = 0;
    let t = 0;
    const gaps: number[] = [];
    for (const gap of trace) {
      t += DT * 1000;
      const instant = (gap - prevGap) / DT;
      velocity += (instant - velocity) * 0.35;
      prevGap = gap;
      const r = trigger.update(
        { t, dt: DT, handsPresent: true, gap, area: gap * gap, gapVelocity: velocity },
        cfg,
      );
      if (r.release) gaps.push(gap);
    }
    return gaps;
  }

  /** Close, then open slowly enough to land a frame in every band. */
  const SLOW_CYCLE = [
    ...Array.from({ length: 10 }, () => 1.6),
    ...Array.from({ length: 8 }, (_, i) => 1.6 - (1.55 * (i + 1)) / 8), // close
    ...Array.from({ length: 6 }, () => 0.05), // held shut
    ...Array.from({ length: 40 }, (_, i) => 0.05 + (1.55 * (i + 1)) / 40), // slow open
    ...Array.from({ length: 10 }, () => 1.6),
  ];

  it('blooms at the release threshold, not the close threshold', () => {
    const gaps = releaseGaps(SLOW_CYCLE);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(DEFAULT_CONFIG.releaseThreshold);
  });

  it('raising it makes the portal wait longer before blooming', () => {
    // Kept under `openThreshold` (0.9): above it the fast-open catch fires first
    // and effectively caps the release — see the fast-open test below.
    const early = releaseGaps(SLOW_CYCLE, { releaseThreshold: 0.5 })[0];
    const late = releaseGaps(SLOW_CYCLE, { releaseThreshold: 0.8 })[0];
    expect(late).toBeGreaterThan(early);
    expect(late).toBeGreaterThanOrEqual(0.8);
  });

  it('is clamped up to the close threshold rather than inverting', () => {
    // A release below the close threshold would bloom while still counted shut.
    const gaps = releaseGaps(SLOW_CYCLE, { closeThreshold: 0.5, releaseThreshold: 0.1 });
    expect(gaps[0]).toBeGreaterThanOrEqual(0.5);
  });

  it('still releases exactly once per cycle at the new threshold', () => {
    const trace: number[] = [];
    for (let i = 0; i < 20; i++) trace.push(...SLOW_CYCLE);
    expect(releaseGaps(trace)).toHaveLength(20);
  });

  it('a release above the open threshold still fires, via the fast-open catch', () => {
    // openThreshold re-arms the trigger; the release must not be lost behind it.
    const gaps = releaseGaps(SLOW_CYCLE, { openThreshold: 0.9, releaseThreshold: 2.5 });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThan(0.9);
  });

  it('does not bloom when the hands only drift inside the closed band', () => {
    // Opens to 0.55 — past the close threshold but short of the release one.
    const trace = [
      ...Array.from({ length: 10 }, () => 1.6),
      ...Array.from({ length: 8 }, (_, i) => 1.6 - (1.55 * (i + 1)) / 8),
      ...Array.from({ length: 6 }, () => 0.05),
      ...Array.from({ length: 20 }, (_, i) => 0.05 + (0.5 * (i + 1)) / 20),
      ...Array.from({ length: 20 }, () => 0.55),
    ];
    expect(releaseGaps(trace)).toHaveLength(0);
  });
});
