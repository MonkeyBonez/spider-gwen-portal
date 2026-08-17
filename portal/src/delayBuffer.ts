/**
 * Sync compensation — the PRD §2.3 "V2" ring buffer.
 *
 * The problem it solves: Lucy's frames arrive ~730ms after the moment they
 * depict (measured 2026-08-16), but the portal polygon is computed from the
 * *live* hands. Composite those together and the window sits where your hands
 * are now while its contents show where you were — so the transformed hands
 * inside the frame slide around against the real hands bordering it. That seam
 * is the visible artifact, not the delay itself.
 *
 * The fix is to hold the raw feed *and* the portal geometry until Lucy catches
 * up, so all three layers depict the same instant. What that costs is a preview
 * delayed by the same amount, which is why it is a toggle rather than a default
 * — see `Config.syncDelayMs`.
 *
 * **Frames are copied into canvases, not held as `VideoFrame`s.** WebCodecs
 * would be cheaper, but holding a couple of dozen frames from a live
 * `MediaStreamTrack` can exhaust the capture pool and stall the camera. The
 * stream is already running at half the camera's rate, so trading frames for
 * memory would be the wrong way round.
 */

import type { PortalPoints } from './geometry';

/**
 * Hard cap on retained frames. Since only distinct camera frames are stored,
 * at 30fps this is ~1.3s of delay — comfortably past the measured ~730ms Δ. At
 * 1280×720 it is roughly 145MB of canvas, which is the real reason for a cap.
 */
const MAX_FRAMES = 40;

export interface DelayedFrame {
  /** The composited-from image: a copy of the camera frame at `t`. */
  image: HTMLCanvasElement;
  /** Portal geometry as it was at `t`, or null if no hands were visible then. */
  portal: PortalPoints | null;
  /** Portal opacity at `t`, so the fade in/out stays aligned too. */
  opacity: number;
  t: number;
}

export class DelayBuffer {
  private frames: DelayedFrame[] = [];
  private next = 0;
  private width = 0;
  private height = 0;
  /** Largest delay the ring could actually satisfy on the last sample, ms. */
  private achievableMs = 0;
  /**
   * `currentTime` of the last frame stored, used to skip repeats.
   *
   * The render loop runs at the display's 60fps while the camera delivers 30
   * (measured 2026-08-16), so half of all pushes would otherwise store a
   * duplicate of the previous frame. That is not merely wasteful: at 60 stores
   * a second, 730ms of delay needs 46 slots, over the 40-frame cap — so the
   * buffer would silently under-delay and the seam it exists to fix would stay
   * broken. Storing one copy per distinct camera frame halves the requirement.
   */
  private lastSourceTime = -1;

  /** Discard everything — on resize, or when compensation is switched off. */
  reset(): void {
    this.frames = [];
    this.next = 0;
    this.achievableMs = 0;
    this.lastSourceTime = -1;
  }

  /** How much delay the buffer can currently deliver. Below the requested Δ
   *  means the ring is too short for this frame rate, and the caller should say
   *  so rather than silently under-delaying. */
  get capacityMs(): number {
    return this.achievableMs;
  }

  get size(): number {
    return this.frames.length;
  }

  /**
   * Record the current instant. Call once per rendered frame, before sampling;
   * repeated calls within one camera frame are ignored.
   */
  push(
    source: HTMLVideoElement,
    width: number,
    height: number,
    portal: PortalPoints | null,
    opacity: number,
    t: number,
    delayMs: number,
    frameIntervalMs: number,
  ): void {
    if (width === 0 || height === 0) return;
    // One stored copy per distinct camera frame — see `lastSourceTime`.
    if (source.currentTime === this.lastSourceTime) return;
    this.lastSourceTime = source.currentTime;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.reset();
    }

    // Sized from the *camera* interval, not the render interval, since that is
    // now the rate at which slots are consumed.
    const wanted = Math.min(
      MAX_FRAMES,
      // +2 so there is a frame either side of the target instant to pick from,
      // rather than the target always landing on the oldest entry.
      Math.max(2, Math.ceil(delayMs / Math.max(1, frameIntervalMs)) + 2),
    );

    if (this.frames.length < wanted) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      this.frames.push({ image: canvas, portal, opacity, t });
      this.next = this.frames.length % wanted;
      paint(canvas, source, width, height);
      return;
    }

    // Shrinking (the delay was lowered): drop the excess rather than keeping
    // stale frames alive and the memory with them.
    if (this.frames.length > wanted) {
      this.frames = this.frames.slice(0, wanted);
      this.next %= wanted;
    }

    const slot = this.frames[this.next];
    slot.portal = portal;
    slot.opacity = opacity;
    slot.t = t;
    paint(slot.image, source, width, height);
    this.next = (this.next + 1) % this.frames.length;
  }

  /**
   * The frame closest to `t - delayMs`.
   *
   * Returns the *nearest* entry rather than the newest one at or before the
   * target: at 14fps the frames are 70ms apart, so rounding to the closest
   * halves the alignment error compared with always rounding down.
   */
  sample(t: number, delayMs: number): DelayedFrame | null {
    if (this.frames.length === 0) return null;
    const target = t - delayMs;
    let best: DelayedFrame | null = null;
    let bestErr = Infinity;
    let oldest = Infinity;
    for (const f of this.frames) {
      if (f.t < oldest) oldest = f.t;
      const err = Math.abs(f.t - target);
      if (err < bestErr) {
        bestErr = err;
        best = f;
      }
    }
    this.achievableMs = t - oldest;
    return best;
  }
}

function paint(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  width: number,
  height: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(source, 0, 0, width, height);
}
