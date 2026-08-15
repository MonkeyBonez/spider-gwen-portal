/**
 * Portal switch transition (PRD §4.1).
 *
 * On a dimension switch the portal stops tracking the fingertips for a moment:
 * it collapses, holds shut, then reopens onto wherever the fingers now are.
 * The dimension swap happens during the hold, so the change is masked by the
 * effect itself rather than by however well the hands happened to occlude the
 * portal that take. In Phase 1 that hold is where `setPrompt` fires.
 *
 * The whole family is one formula:
 *
 *     rendered[i] = lerp(anchor(kind, i), live[i], closure)
 *
 * `closure` runs 1 → 0 → 1 over the timeline; the variants differ only in where
 * each point collapses *to*. `closure` may exceed 1 during the reopen when
 * overshoot is on, which pops the portal briefly wider than the fingers.
 *
 * Important: this transform is display-only. The gesture state machine keeps
 * reading the un-animated landmarks, otherwise the animation would feed back
 * into the trigger that spawned it.
 */

import type { PortalPoints, Pt } from './geometry';

export type TransitionKind = 'none' | 'iris' | 'shutter' | 'eyelid' | 'twist' | 'wipe';

export const TRANSITION_KINDS: TransitionKind[] = [
  'none',
  'iris',
  'shutter',
  'eyelid',
  'twist',
  'wipe',
];

/** One-line pitch per variant, surfaced in the debug panel. */
export const TRANSITION_BLURBS: Record<TransitionKind, string> = {
  none: 'Instant swap, no animation (Phase 0 baseline).',
  iris: 'Shrinks to a point at the centre and blooms back. Camera-shutter feel.',
  shutter: 'Squeezes horizontally to a vertical slit — matches how the hands really close.',
  eyelid: 'Index tips fall to the thumbs, then lift. Reads as a blink.',
  twist: 'Iris plus a rotation, so the portal spins shut and unwinds.',
  wipe: 'Collapses sideways onto one edge and sweeps back open.',
};

export interface TransitionSpec {
  kind: TransitionKind;
  collapseMs: number;
  holdMs: number;
  reopenMs: number;
  /** Back-easing strength on the reopen. 0 = plain ease-out, ~1.7 = strong pop. */
  overshoot: number;
  /** Peak rotation for `twist`, in degrees. */
  twistDegrees: number;
}

export type TransitionPhase = 'idle' | 'collapse' | 'hold' | 'reopen';

export interface TransitionState {
  phase: TransitionPhase;
  /** 0 = fully collapsed, 1 = attached to the fingertips, >1 = overshoot. */
  closure: number;
  /** Rotation to apply, radians. Non-zero only for `twist`. */
  twist: number;
  /** True on the single frame where the dimension should change. */
  swap: boolean;
}

const IDLE: TransitionState = { phase: 'idle', closure: 1, twist: 0, swap: false };

export class PortalTransition {
  private startedAt = -Infinity;
  private swapped = true;

  /** Begin a transition. The swap is deferred to the hold (or to now, if instant). */
  trigger(t: number): void {
    this.startedAt = t;
    this.swapped = false;
  }

  get active(): boolean {
    return !this.swapped || this.startedAt !== -Infinity;
  }

  reset(): void {
    this.startedAt = -Infinity;
    this.swapped = true;
  }

  update(t: number, spec: TransitionSpec): TransitionState {
    if (this.startedAt === -Infinity) return IDLE;

    const instant = spec.kind === 'none';
    const collapseMs = instant ? 0 : Math.max(0, spec.collapseMs);
    const holdMs = instant ? 0 : Math.max(0, spec.holdMs);
    const reopenMs = instant ? 0 : Math.max(0, spec.reopenMs);

    const collapseEnd = this.startedAt + collapseMs;
    const holdEnd = collapseEnd + holdMs;
    const reopenEnd = holdEnd + reopenMs;

    // The swap lands the instant the portal is fully shut.
    let swap = false;
    if (!this.swapped && t >= collapseEnd) {
      this.swapped = true;
      swap = true;
    }

    if (t >= reopenEnd) {
      this.startedAt = -Infinity;
      return { ...IDLE, swap };
    }

    let phase: TransitionPhase;
    let closure: number;
    if (t < collapseEnd) {
      phase = 'collapse';
      closure = 1 - easeInCubic(norm(t - this.startedAt, collapseMs));
    } else if (t < holdEnd) {
      phase = 'hold';
      closure = 0;
    } else {
      phase = 'reopen';
      closure = easeOutBack(norm(t - holdEnd, reopenMs), spec.overshoot);
    }

    const twist =
      spec.kind === 'twist' ? (1 - clamp01(closure)) * (spec.twistDegrees * Math.PI) / 180 : 0;

    return { phase, closure, twist, swap };
  }
}

/** Where each portal point collapses to, in polygon order. */
function anchors(kind: TransitionKind, p: PortalPoints, centre: Pt): Pt[] {
  switch (kind) {
    case 'shutter':
      // Horizontal squeeze onto the vertical midline: the fingertips of the two
      // hands meeting, which is what physically happens when you close the gesture.
      return [
        { x: centre.x, y: p.lIndex.y },
        { x: centre.x, y: p.rIndex.y },
        { x: centre.x, y: p.rThumb.y },
        { x: centre.x, y: p.lThumb.y },
      ];
    case 'eyelid':
      // Index tips drop onto their own thumb; the thumb line holds still.
      return [p.lThumb, p.rThumb, p.rThumb, p.lThumb];
    case 'wipe':
      // Left points slide onto their right counterparts — closes to one edge.
      return [p.rIndex, p.rIndex, p.rThumb, p.rThumb];
    case 'iris':
    case 'twist':
    case 'none':
    default:
      return [centre, centre, centre, centre];
  }
}

/**
 * Display-only reshaping of the portal. Returns the input untouched when idle,
 * so there is no cost outside a transition.
 */
export function applyTransition(
  portal: PortalPoints,
  state: TransitionState,
  kind: TransitionKind,
): PortalPoints {
  if (state.phase === 'idle' || kind === 'none') return portal;

  const live = [portal.lIndex, portal.rIndex, portal.rThumb, portal.lThumb];
  const centre: Pt = {
    x: live.reduce((s, q) => s + q.x, 0) / 4,
    y: live.reduce((s, q) => s + q.y, 0) / 4,
  };
  const target = anchors(kind, portal, centre);

  const cos = Math.cos(state.twist);
  const sin = Math.sin(state.twist);

  const moved = live.map((q, i) => {
    const a = target[i];
    let x = a.x + (q.x - a.x) * state.closure;
    let y = a.y + (q.y - a.y) * state.closure;
    if (state.twist !== 0) {
      const dx = x - centre.x;
      const dy = y - centre.y;
      x = centre.x + dx * cos - dy * sin;
      y = centre.y + dx * sin + dy * cos;
    }
    return { x, y };
  });

  return {
    lIndex: moved[0],
    rIndex: moved[1],
    rThumb: moved[2],
    lThumb: moved[3],
    handSize: portal.handSize,
  };
}

function norm(elapsed: number, duration: number): number {
  return duration <= 0 ? 1 : clamp01(elapsed / duration);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeInCubic(p: number): number {
  return p * p * p;
}

/** Ease-out with optional overshoot past 1. `s` = 0 degrades to a cubic ease-out. */
function easeOutBack(p: number, s: number): number {
  const k = p - 1;
  return 1 + (s + 1) * k * k * k + s * k * k;
}
