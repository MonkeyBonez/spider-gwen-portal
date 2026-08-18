/**
 * Records a *take*: the thing the performer actually made, ready to look back at.
 *
 * This is the export path (PRD Phase 1.5), and it is deliberately not the same
 * machinery as recorder.ts. That one records the camera and Lucy streams raw
 * and unmixed, because the offset between them is the thing under
 * investigation. This one records the composite — the picture — because that is
 * the artifact.
 *
 * ## One encoder
 *
 * The whole design turns on refusing to run a second video encoder. Recording
 * the camera and Lucy separately, so they could be toggled apart later, was
 * measured on 2026-08-17 to cost ~7fps of outbound frame rate and ~30ms of Δ —
 * the performer would be performing against a worse portal in order to get a
 * more editable file. That is the wrong trade for the person holding their
 * hands up.
 *
 * So: **one MediaRecorder, on the composite canvas.** Everything that is not
 * the picture — outline, labels, landmarks — is recorded as an `OverlayFrame`
 * per rendered frame, a few hundred bytes of geometry rather than a video
 * track. The review player redraws those live, so toggling a layer is a redraw
 * and costs nothing. What this consciously gives up is separating the camera
 * from Lucy after the fact; they are baked together, and that is the price of
 * not degrading the take.
 *
 * ## Timebase
 *
 * Frame times are measured from the **first painted frame**, not from
 * `recorder.start()`, and that distinction is the whole of the alignment.
 *
 * `canvas.captureStream()` emits a frame only when the canvas is *modified*. We
 * start recording as soon as the canvas has a size, but nothing is painted into
 * it until the first pass of the render loop — which is also the first pass of
 * MediaPipe, so it is slow. The recorder therefore sits idle for a lead-in of
 * order 100–200ms, and the video's `t = 0` is the first paint rather than the
 * `start()` call.
 *
 * Stamping overlay frames from `start()` put every one of them that lead-in
 * behind the video: about 5–7 frames at 30fps, constant for the whole take, and
 * plainly visible as an outline trailing the hands. Since the first painted
 * frame *is* the video's first frame, using it as the zero lines the two up by
 * construction — no clock correlation, no calibration pass, nothing to drift.
 * `leadInMs` in `take:stop` records what the gap was.
 *
 * ## Memory
 *
 * Chunks are held in memory rather than streamed to disk, because unlike the
 * diagnostic recordings this file is *for* the person at the keyboard: it has to
 * be playable the instant they press end, and a dev-server round trip would put
 * it somewhere they cannot reach from a build. The cap below is what stops that
 * being unbounded.
 */

import { sessionLog } from './sessionLog';
import type { OverlayFrame } from './overlay';

/**
 * Encoder preference. **mp4 first**, deliberately: the artifact is meant to be
 * posted, and every platform and phone takes mp4 while WebM is still a coin
 * flip off the desktop. Chrome only grew mp4 `MediaRecorder` support recently,
 * so the WebM fallbacks stay — whichever is chosen is logged, because it
 * decides whether the file the user gets is directly postable.
 */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/**
 * Export bitrate. Far above recorder.ts's 2Mbps: that one only has to make
 * motion legible for analysis, this one is the finished video.
 */
const BITS_PER_SECOND = 8_000_000;

/** Capture rate for the canvas stream. */
const FPS = 30;

/**
 * Hard ceiling on one take. At 8Mbps a 3-minute take is ~180MB held in memory,
 * which is already more than anyone wants to review in one sitting; past this
 * the tab is at risk and the recording stops itself rather than being killed.
 */
const MAX_TAKE_MS = 3 * 60 * 1000;

/** Overlay frames are pushed at render rate, so the cap tracks the time cap. */
const MAX_FRAMES = Math.ceil((MAX_TAKE_MS / 1000) * 70);

export interface TakeFrame {
  /** ms since recording started — i.e. `video.currentTime * 1000`. */
  t: number;
  frame: OverlayFrame;
}

export interface Take {
  blob: Blob;
  /** Object URL for `blob`. Revoke via `releaseTake` when done. */
  url: string;
  mimeType: string;
  /** File extension implied by `mimeType`, without the dot. */
  extension: string;
  width: number;
  height: number;
  durationMs: number;
  frames: TakeFrame[];
  startedAtIso: string;
  /** True when the take hit `MAX_TAKE_MS` and was cut short. */
  truncated: boolean;
}

export function releaseTake(take: Take): void {
  URL.revokeObjectURL(take.url);
}

export class TakeRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private frames: TakeFrame[] = [];
  private startedAt = 0;
  /** When the first frame was actually painted — the video's true zero. */
  private firstFrameAt = -1;
  private width = 0;
  private height = 0;
  private mimeType = '';
  private startedAtIso = '';
  private truncated = false;
  private stopped: Promise<void> | null = null;

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** The instant the recording's timeline starts from. See the header. */
  private zeroAt(): number {
    return this.firstFrameAt >= 0 ? this.firstFrameAt : this.startedAt;
  }

  /**
   * How long the *recording* is, which is zero until something has been
   * painted. During the lead-in the recorder is running but the file has not
   * begun, and reporting wall-clock time there would put the HUD clock ahead of
   * the take it is counting.
   */
  elapsedMs(now: number): number {
    if (!this.active || this.firstFrameAt < 0) return 0;
    return now - this.firstFrameAt;
  }

  /**
   * Begin recording `canvas`. **Returns false rather than throwing**, for the
   * same reason recorder.ts does: this must never be able to take down the
   * session it is capturing.
   */
  start(canvas: HTMLCanvasElement, now: number): boolean {
    if (this.recorder) return true;
    try {
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      if (!mimeType) {
        sessionLog.log('take:unsupported', {});
        return false;
      }
      if (canvas.width === 0 || canvas.height === 0) {
        sessionLog.log('take:not-ready', { width: canvas.width, height: canvas.height });
        return false;
      }
      const stream = canvas.captureStream(FPS);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: BITS_PER_SECOND,
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      recorder.onerror = (e) => sessionLog.log('take:error', { error: String(e) });
      // No timeslice: one `dataavailable` at stop. Nothing is reading this
      // mid-flight, and a single blob avoids any question of cluster ordering.
      recorder.start();
      this.recorder = recorder;
      this.stream = stream;
      this.chunks = [];
      this.frames = [];
      this.truncated = false;
      this.startedAt = now;
      this.firstFrameAt = -1;
      this.width = canvas.width;
      this.height = canvas.height;
      this.mimeType = mimeType;
      this.startedAtIso = new Date().toISOString();
      sessionLog.log('take:start', {
        mimeType,
        size: `${this.width}×${this.height}`,
        fps: FPS,
        wallClock: this.startedAtIso,
      });
      return true;
    } catch (err) {
      sessionLog.log('take:failed', { error: String(err) });
      this.recorder = null;
      this.stream = null;
      return false;
    }
  }

  /**
   * Record one frame's overlay. Cheap and unconditional — the caller has
   * already built the frame for the live overlay canvas, so this stores the
   * same object rather than rebuilding it.
   */
  pushFrame(now: number, frame: OverlayFrame): void {
    if (!this.active) return;
    if (this.frames.length >= MAX_FRAMES) return;
    // The first paint is the video's first frame, so it is time zero for both.
    if (this.firstFrameAt < 0) this.firstFrameAt = now;
    this.frames.push({ t: now - this.firstFrameAt, frame });
  }

  /** True once the take has run past its ceiling and should be ended. */
  overLimit(now: number): boolean {
    return this.active && now - this.zeroAt() >= MAX_TAKE_MS;
  }

  markTruncated(): void {
    this.truncated = true;
  }

  /**
   * Stop and assemble. Resolves only once the encoder has handed back its final
   * data — returning earlier would produce a file missing its tail, which plays
   * for a shorter time than the take actually ran.
   */
  async stop(now: number): Promise<Take | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    // Measured from the first paint, so it matches the file's own duration
    // rather than the wall clock — the scrubber is drawn from this.
    const zero = this.zeroAt();
    const durationMs = now - zero;
    const leadInMs = zero - this.startedAt;
    if (!this.stopped) {
      this.stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          if (recorder.state !== 'inactive') recorder.stop();
          else resolve();
        } catch (err) {
          sessionLog.log('take:stop-failed', { error: String(err) });
          resolve();
        }
      });
    }
    await this.stopped;
    this.stream?.getTracks().forEach((t) => t.stop());

    const chunks = this.chunks;
    const frames = this.frames;
    const mimeType = this.mimeType;
    this.recorder = null;
    this.stream = null;
    this.stopped = null;
    this.chunks = [];
    this.frames = [];

    const bytes = chunks.reduce((n, c) => n + c.size, 0);
    if (bytes === 0) {
      sessionLog.log('take:empty', { frames: frames.length, durationMs: Math.round(durationMs) });
      return null;
    }
    const blob = new Blob(chunks, { type: mimeType });
    sessionLog.log('take:stop', {
      durationMs: Math.round(durationMs),
      bytes,
      frames: frames.length,
      mimeType,
      truncated: this.truncated,
      // How long the recorder ran before anything was painted into the canvas.
      // This used to be the overlay's alignment error, so it is worth watching:
      // if it grows, the first render is getting slower.
      leadInMs: Math.round(leadInMs),
    });
    return {
      blob,
      url: URL.createObjectURL(blob),
      mimeType,
      extension: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm',
      width: this.width,
      height: this.height,
      durationMs,
      frames,
      startedAtIso: this.startedAtIso,
      truncated: this.truncated,
    };
  }
}

/**
 * The overlay to draw at `ms` into the take.
 *
 * Binary search for the nearest recorded frame, then reject it if it is further
 * away than `toleranceMs`. The rejection matters: a take can contain stretches
 * with no overlay recorded at all (the tab was backgrounded, the loop stalled),
 * and reusing a frame from either side of such a gap would pin a stale portal
 * on screen for as long as the gap lasted — worse than drawing nothing, because
 * it looks deliberate.
 */
export function overlayAt(
  frames: TakeFrame[],
  ms: number,
  toleranceMs = 100,
): OverlayFrame | null {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < ms) lo = mid + 1;
    else hi = mid;
  }
  const after = frames[lo];
  const before = frames[lo - 1];
  let best = after;
  if (before && Math.abs(before.t - ms) < Math.abs(after.t - ms)) best = before;
  return Math.abs(best.t - ms) <= toleranceMs ? best.frame : null;
}
