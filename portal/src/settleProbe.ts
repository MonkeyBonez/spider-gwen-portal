/**
 * Measures how long Lucy takes to *visibly* settle after a `setPrompt`.
 *
 * This is PRD §7's first open question, and the 2026-08-16 run showed why it
 * matters: the server ack came back 1.5–1.9s after the switch, and the pixels
 * arrive later still, so the portal has reopened long before the new dimension
 * appears. The gesture cannot mask a swap it finishes before.
 *
 * **It records a curve rather than deciding.** The obvious approach — threshold
 * a frame-difference signal and declare "settled" — needs a threshold nobody
 * has data to choose, and the subject is moving the whole time, so hand motion
 * and restyling both show up as change. So this samples cheaply, logs the
 * series, and leaves the judgement to whoever reads the log. Once the shape is
 * known, a detector can be written against it.
 *
 * Two signals per sample:
 * - `vsPrompt` — difference from the frame at the instant the prompt was sent.
 *   Climbs as the restyle takes hold, then plateaus. The plateau is the answer.
 * - `vsPrev` — difference from the previous sample. Spikes during the
 *   transition and settles back to whatever the subject's own motion produces,
 *   which is the control that keeps `vsPrompt` honest.
 */

/** Sampling resolution. Tiny on purpose: this must not cost a frame. */
const W = 32;
const H = 18;
const INTERVAL_MS = 100;
const DURATION_MS = 6000;

export interface SettleSample {
  /** ms since the prompt was sent. */
  t: number;
  /** Mean absolute luma difference from the frame at prompt time, 0–255. */
  vsPrompt: number;
  /** Mean absolute luma difference from the previous sample, 0–255. */
  vsPrev: number;
}

export class SettleProbe {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D | null;
  private atPrompt: Uint8ClampedArray | null = null;
  private previous: Uint8ClampedArray | null = null;
  private samples: SettleSample[] = [];
  private startedAt = 0;
  private timer = 0;
  private onDone: ((samples: SettleSample[]) => void) | null = null;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    // `willReadFrequently` — this does nothing but getImageData, and without
    // the hint Chrome keeps the canvas GPU-side and every read is a stall.
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** True while a measurement is running. A second prompt restarts it. */
  get running(): boolean {
    return this.timer !== 0;
  }

  /**
   * Begin measuring. `source` must already be producing frames; if it is not,
   * the run is abandoned rather than recording a curve of zeros.
   */
  start(source: HTMLVideoElement, onDone: (samples: SettleSample[]) => void): void {
    this.stop();
    const frame = this.grab(source);
    if (!frame) return;
    this.atPrompt = frame;
    this.previous = frame;
    this.samples = [];
    this.startedAt = performance.now();
    this.onDone = onDone;
    this.timer = window.setInterval(() => this.tick(source), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.onDone = null;
  }

  private tick(source: HTMLVideoElement): void {
    const now = performance.now();
    const elapsed = now - this.startedAt;
    const frame = this.grab(source);
    if (frame && this.atPrompt && this.previous) {
      this.samples.push({
        t: Math.round(elapsed),
        vsPrompt: round1(meanAbsDiff(frame, this.atPrompt)),
        vsPrev: round1(meanAbsDiff(frame, this.previous)),
      });
      this.previous = frame;
    }
    if (elapsed >= DURATION_MS) {
      const done = this.onDone;
      const samples = this.samples;
      this.stop();
      done?.(samples);
    }
  }

  /** Downscaled luma of the current frame, or null if nothing has decoded. */
  private grab(source: HTMLVideoElement): Uint8ClampedArray | null {
    if (!this.ctx || source.readyState < 2 || source.videoWidth === 0) return null;
    this.ctx.drawImage(source, 0, 0, W, H);
    const { data } = this.ctx.getImageData(0, 0, W, H);
    const luma = new Uint8ClampedArray(W * H);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // Rec. 601 luma. Colour would be more sensitive to a restyle, but luma is
      // a quarter of the data and the transitions here are not subtle.
      luma[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    }
    return luma;
  }
}

function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
