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

describe('CloseOpenTrigger', () => {
  it('advances exactly once per close→open cycle over 20 cycles', () => {
    const { advances } = run(new CloseOpenTrigger(), gapTrace(20));
    expect(advances).toBe(20);
  });

  it('is unchanged by landmark noise', () => {
    const { advances } = run(new CloseOpenTrigger(), gapTrace(20), { noise: 0.04 });
    expect(advances).toBe(20);
  });

  it('advances once per cycle when firing on opening instead of closing', () => {
    const { advances } = run(new CloseOpenTrigger(), gapTrace(20), {
      cfg: { advanceOn: 'opening' },
    });
    expect(advances).toBe(20);
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
