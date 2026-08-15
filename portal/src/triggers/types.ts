/**
 * Gesture trigger interface (PRD §9: "keep the gesture trigger logic behind an
 * interface so alternative trigger strategies can be swapped in").
 *
 * A trigger consumes per-frame signals and decides when the dimension advances.
 * In Phase 0 "advance" swaps a fill colour; in Phase 1 it calls Lucy's
 * `setPrompt`. Nothing else about the app needs to change.
 */

import type { Config } from '../config';

export interface TriggerSignals {
  /** performance.now() timestamp of this frame, ms. */
  t: number;
  /** Seconds since the previous frame. */
  dt: number;
  /** Both hands tracked this frame. */
  handsPresent: boolean;
  /** Hand-size-normalised gap between the fingertip pairs. */
  gap: number;
  /** Hand-size-normalised polygon area. */
  area: number;
  /** d(gap)/dt in normalised units per second (smoothed). Negative = closing. */
  gapVelocity: number;
}

export type PortalState = 'IDLE' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'OPENING';

export interface TriggerResult {
  state: PortalState;
  /** Fire the dimension switch on this frame. */
  advance: boolean;
  /**
   * The portal is closed enough to hide a transition. Phase 1 uses this to time
   * `setPrompt` so the model's transition frames land behind closed hands.
   */
  closed: boolean;
}

export interface GestureTrigger {
  readonly name: string;
  update(signals: TriggerSignals, cfg: Config): TriggerResult;
  reset(): void;
  /** Extra key/value readouts for the debug panel. */
  debug(): Record<string, string | number>;
}
