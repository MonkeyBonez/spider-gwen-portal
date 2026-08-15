/**
 * Trigger v1 — "close → open advances the dimension" (PRD §2.2, Sne's proposal).
 *
 *   OPEN → CLOSING → CLOSED → OPENING → OPEN
 *
 * - Fingertips moving together AND gap below `closeThreshold` for
 *   `debounceFrames` consecutive frames latches CLOSED and arms the trigger.
 * - Moving apart from CLOSED (gap back above `openThreshold`) disarms it.
 * - `advanceOn` decides *when* the switch actually fires:
 *     'closed'  — at the CLOSED latch, so the swap is hidden behind the hands
 *                 (this is the §2.2 design intent, and what Phase 1 wants).
 *     'opening' — at the moment the hands start to part.
 * - `cooldownMs` prevents rapid-fire flapping.
 *
 * Tracking dropouts do not reset the machine immediately: an arm survives a
 * short dropout (`lostResetMs`) so a fully-occluded close still counts.
 */

import type { Config } from '../config';
import type { GestureTrigger, PortalState, TriggerResult, TriggerSignals } from './types';

export class CloseOpenTrigger implements GestureTrigger {
  readonly name = 'close-open-v1';

  private state: PortalState = 'IDLE';
  private closeFrames = 0;
  private armed = false;
  private lastAdvanceAt = -Infinity;
  private lastSeenAt = -Infinity;
  private suppressedByCooldown = false;

  reset(): void {
    this.state = 'IDLE';
    this.closeFrames = 0;
    this.armed = false;
    this.suppressedByCooldown = false;
  }

  update(s: TriggerSignals, cfg: Config): TriggerResult {
    if (!s.handsPresent) {
      // Hold state briefly so an occluded close still latches, then give up.
      if (s.t - this.lastSeenAt > cfg.lostResetMs) this.reset();
      return { state: this.state === 'IDLE' ? 'IDLE' : this.state, advance: false, closed: this.armed };
    }
    this.lastSeenAt = s.t;

    const eps = cfg.velocityEpsilon;
    const closing = eps <= 0 || s.gapVelocity < -eps;
    const opening = eps <= 0 || s.gapVelocity > eps;
    const isTouching = s.gap < cfg.closeThreshold;
    const isOpen = s.gap > cfg.openThreshold;

    let advance = false;
    this.suppressedByCooldown = false;

    if (this.state === 'IDLE') {
      this.state = isTouching ? 'CLOSING' : 'OPEN';
    }

    if (!this.armed) {
      // Looking for a confirmed close.
      if (isTouching && (closing || this.closeFrames > 0)) {
        this.closeFrames++;
        this.state = 'CLOSING';
        if (this.closeFrames >= cfg.debounceFrames) {
          this.state = 'CLOSED';
          this.armed = true;
          if (cfg.advanceOn === 'closed') advance = this.tryFire(s.t, cfg);
        }
      } else {
        this.closeFrames = 0;
        if (isOpen) this.state = 'OPEN';
      }
    } else {
      // Armed: waiting for the hands to part again.
      this.state = 'CLOSED';
      if (opening && !isTouching) this.state = 'OPENING';
      if (isOpen) {
        if (cfg.advanceOn === 'opening') advance = this.tryFire(s.t, cfg);
        this.armed = false;
        this.closeFrames = 0;
        this.state = 'OPEN';
      }
    }

    return { state: this.state, advance, closed: this.armed || this.state === 'CLOSED' };
  }

  private tryFire(t: number, cfg: Config): boolean {
    if (t - this.lastAdvanceAt < cfg.cooldownMs) {
      this.suppressedByCooldown = true;
      return false;
    }
    this.lastAdvanceAt = t;
    return true;
  }

  debug(): Record<string, string | number> {
    return {
      armed: this.armed ? 'yes' : 'no',
      closeFrames: this.closeFrames,
      cooldown: this.suppressedByCooldown ? 'SUPPRESSED' : '—',
    };
  }
}
