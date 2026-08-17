/**
 * Measures how long Lucy takes to *visibly* settle after a `setPrompt`.
 *
 * This is PRD §7's first open question, and the 2026-08-16 run showed why it
 * matters: the server ack came back 1.5–1.9s after the switch, and the pixels
 * arrive later still, so the portal has reopened long before the new dimension
 * appears. The gesture cannot mask a swap it finishes before.
 *
 * **It also detects the change live**, which is what the reveal cross-fade is
 * driven from. The SDK cannot help here: `setPrompt` resolves on a `prompt_ack`
 * websocket message, which confirms the server *received* the prompt, not that
 * the output has changed. Nothing in the API marks an output frame as belonging
 * to a prompt. So the pixels are the only source of truth.
 *
 * The threshold was chosen from measured curves rather than invented: across
 * five switches the frame-to-frame difference sat at 0–21 while the subject
 * moved, then spiked to 52–94 in a single sample as the restyle landed. The
 * rule below wants both an absolute floor and a multiple of the running
 * baseline, so a large but gradual movement cannot trip it.
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
// 50ms rather than 100: this now gates the reveal, so the sampling period is
// dead colour on screen. A 32×18 getImageData twice as often is nothing.
const INTERVAL_MS = 50;
// 4s, down from 6: the change is detected inside a second and the plateau is
// established well before this, and a shorter window means fewer measurements
// lost to the next switch arriving mid-run.
const DURATION_MS = 4000;

/**
 * Frame-to-frame difference that counts as the restyle landing.
 *
 * Floor: the smallest measured spike was 52 and the largest motion-only
 * baseline was 21, so 35 sits between them with room either side.
 */
const SPIKE_FLOOR = 35;
/** ...and it must also be this many times the recent baseline. */
const SPIKE_RATIO = 3;
/** Baseline never goes below this, so the ratio test can't divide by noise. */
const BASELINE_FLOOR = 5;

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
  private onChange: (() => void) | null = null;
  private detectedAt: number | null = null;

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
  start(
    source: HTMLVideoElement,
    onDone: (samples: SettleSample[], detectedAtMs: number | null, truncated?: boolean) => void,
    onChange?: () => void,
  ): void {
    // Hand back whatever the previous run gathered before discarding it. A
    // switch arriving inside the window used to cancel the measurement
    // silently: four switches in one run produced one curve, and the three
    // fastest — the interesting ones — left no trace at all.
    this.flushPartial();
    this.stop();
    const frame = this.grab(source);
    if (!frame) return;
    this.atPrompt = frame;
    this.previous = frame;
    this.samples = [];
    this.detectedAt = null;
    this.startedAt = performance.now();
    this.onDone = onDone as (samples: SettleSample[]) => void;
    this.onChange = onChange ?? null;
    this.timer = window.setInterval(() => this.tick(source), INTERVAL_MS);
  }

  /** Emit a truncated result, so an interrupted measurement is still recorded. */
  private flushPartial(): void {
    if (!this.onDone || this.samples.length === 0) return;
    const done = this.onDone as (
      samples: SettleSample[],
      detectedAtMs: number | null,
      truncated?: boolean,
    ) => void;
    done(this.samples, this.detectedAt, true);
    this.onDone = null;
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.onDone = null;
    this.onChange = null;
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
      this.detect(elapsed);
    }
    if (elapsed >= DURATION_MS) {
      const done = this.onDone as
        | ((samples: SettleSample[], detectedAtMs: number | null) => void)
        | null;
      const samples = this.samples;
      const detectedAt = this.detectedAt;
      this.stop();
      done?.(samples, detectedAt);
    }
  }

  /**
   * Fire once, on the sample where the restyle lands.
   *
   * The baseline is the median of everything before this sample rather than a
   * mean, so the spike itself — and any single large movement earlier in the
   * window — cannot drag the reference up and mask a later change.
   */
  private detect(elapsed: number): void {
    if (this.detectedAt !== null || this.samples.length < 2) return;
    const latest = this.samples[this.samples.length - 1].vsPrev;
    const prior = this.samples.slice(0, -1).map((s) => s.vsPrev).sort((a, b) => a - b);
    const baseline = Math.max(BASELINE_FLOOR, prior[Math.floor(prior.length / 2)]);
    if (latest < SPIKE_FLOOR || latest < baseline * SPIKE_RATIO) return;
    this.detectedAt = elapsed;
    const fire = this.onChange;
    this.onChange = null;
    fire?.();
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
