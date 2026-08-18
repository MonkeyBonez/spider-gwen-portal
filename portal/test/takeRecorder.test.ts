/**
 * The take's overlay track (PRD §4.5).
 *
 * The load-bearing claim is that overlays can be recorded as *data* and looked
 * up later from `video.currentTime` alone, with no clock correlation. That
 * makes `overlayAt` the join between the two halves of a take, so it is what
 * gets pinned here: nearest-frame selection, and — the part that is easy to get
 * wrong — refusing to answer across a gap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overlayAt, TakeRecorder, timelineOffsetMs, type TakeFrame } from '../src/takeRecorder';
import { emptyOverlayFrame, overlaysEmpty, type OverlayFrame } from '../src/overlay';

/** A frame tagged with its time, so the one that came back is identifiable. */
function frameAt(t: number): TakeFrame {
  const frame: OverlayFrame = emptyOverlayFrame();
  frame.opacity = t;
  return { t, frame };
}

/** A 30fps track, as the recorder would build it. */
const track: TakeFrame[] = Array.from({ length: 60 }, (_, i) => frameAt(i * 33.3));

describe('overlayAt', () => {
  it('returns null for an empty track rather than throwing', () => {
    expect(overlayAt([], 0)).toBeNull();
  });

  it('finds the exact frame', () => {
    expect(overlayAt(track, 33.3)?.opacity).toBeCloseTo(33.3);
    expect(overlayAt(track, 0)?.opacity).toBe(0);
  });

  it('rounds to the nearer neighbour, on both sides', () => {
    // Just past frame 10 (333ms) and just short of frame 11 (366.3ms).
    expect(overlayAt(track, 340)?.opacity).toBeCloseTo(333);
    expect(overlayAt(track, 360)?.opacity).toBeCloseTo(366.3);
  });

  it('clamps to the ends instead of running off them', () => {
    expect(overlayAt(track, -50)?.opacity).toBe(0);
    expect(overlayAt(track, 1e6, 1e9)?.opacity).toBeCloseTo(59 * 33.3);
  });

  /*
   * The reason the tolerance exists. A take can contain stretches with no
   * overlay recorded — the tab was backgrounded, the render loop stalled — and
   * holding the last known portal across one of those pins a stale polygon on
   * screen for as long as the gap lasts. That reads as deliberate, which is
   * worse than drawing nothing.
   */
  it('refuses to answer across a gap', () => {
    const gapped = [frameAt(0), frameAt(100), frameAt(5000), frameAt(5100)];
    expect(overlayAt(gapped, 2500)).toBeNull();
    expect(overlayAt(gapped, 120)?.opacity).toBe(100);
    expect(overlayAt(gapped, 4950)?.opacity).toBe(5000);
  });

  it('honours a widened tolerance', () => {
    const sparse = [frameAt(0), frameAt(1000)];
    expect(overlayAt(sparse, 400)).toBeNull();
    expect(overlayAt(sparse, 400, 500)?.opacity).toBe(0);
  });

  it('is exact at the tolerance boundary, and null past it', () => {
    const sparse = [frameAt(0), frameAt(1000)];
    expect(overlayAt(sparse, 100, 100)?.opacity).toBe(0);
    expect(overlayAt(sparse, 100.1, 100)).toBeNull();
  });
});

describe('overlaysEmpty', () => {
  // This is the export fast path: when nothing would be drawn, saving hands
  // back the recorded blob untouched instead of re-encoding it. A false
  // negative here costs a needless real-time render and a generation of
  // quality; a false positive silently drops the outline the user asked for.
  it('is true only when every layer is off', () => {
    expect(overlaysEmpty({ portal: false, landmarks: false })).toBe(true);
    expect(overlaysEmpty({ portal: true, landmarks: false })).toBe(false);
    // `landmarks` is live-only and never set in review, but the fast path must
    // still refuse to shortcut if anything at all would be drawn.
    expect(overlaysEmpty({ portal: false, landmarks: true })).toBe(false);
  });
});


/**
 * The recording timeline's zero.
 *
 * `canvas.captureStream()` emits nothing until the canvas is modified, so the
 * video's first frame is the first *paint*, not the `start()` call. Stamping
 * overlay frames from `start()` therefore put all of them behind the video by
 * however long the first render took — MediaPipe's first inference included,
 * which made it hundreds of milliseconds. Sne saw it as the outline trailing
 * the hands by 5–7 frames, constant for the whole take.
 */
describe('take timeline zero', () => {
  const globals = globalThis as Record<string, unknown>;
  const saved = globals.MediaRecorder;

  beforeAll(() => {
    globals.MediaRecorder = class {
      static isTypeSupported(): boolean {
        return true;
      }
      state = 'recording';
      ondataavailable: unknown = null;
      onerror: unknown = null;
      start(): void {}
      stop(): void {}
    };
  });
  afterAll(() => {
    globals.MediaRecorder = saved;
  });

  /** Enough of a canvas for the recorder to attach to. */
  function fakeCanvas(): HTMLCanvasElement {
    return {
      width: 1280,
      height: 720,
      captureStream: () => ({ getTracks: () => [] }),
    } as unknown as HTMLCanvasElement;
  }

  it('starts the clock at the first painted frame, not at start()', () => {
    const rec = new TakeRecorder();
    expect(rec.start(fakeCanvas(), 1000)).toBe(true);

    // 400ms of lead-in with nothing painted: the recorder is running but the
    // canvas is untouched, so the file has not begun.
    expect(rec.elapsedMs(1400)).toBe(0);

    rec.pushFrame(1400, emptyOverlayFrame());
    // That first paint is the file's t=0, so the clock reads zero there...
    expect(rec.elapsedMs(1400)).toBe(0);
    // ...and one second of painting later reads one second, not 1.4.
    expect(rec.elapsedMs(2400)).toBe(1000);
    expect(rec.frameCount).toBe(1);
  });

  it('counts the length cap from the first paint too', () => {
    const rec = new TakeRecorder();
    rec.start(fakeCanvas(), 0);
    rec.pushFrame(60_000, emptyOverlayFrame());
    // 3 minutes after start() but only 2 after the first paint.
    expect(rec.overLimit(180_000)).toBe(false);
    expect(rec.overLimit(241_000)).toBe(true);
  });
});


/**
 * The video-clock correction (see the module header's Timebase section).
 *
 * Measured 2026-08-18: a take that painted for 5772ms produced a file whose
 * frames span 5591ms, and the baked outline lagged the composite by the
 * difference — the encoder drops time, mostly up front, and stamps its first
 * surviving frame t=0. The correction adds the deficit back to every lookup.
 */
describe('timelineOffsetMs', () => {
  it('is the gap between painted time and the file\'s own story', () => {
    expect(timelineOffsetMs(5772, 5.591)).toBeCloseTo(181, 0);
    expect(timelineOffsetMs(10_000, 10)).toBe(0);
  });

  it('never goes negative — a file longer than the take corrects nothing', () => {
    expect(timelineOffsetMs(5000, 5.2)).toBe(0);
  });

  it('caps at 2s rather than silently shifting a broken take by seconds', () => {
    // The measured worst case: a 15s take compacted to 9.2s under load. No
    // constant honestly repairs that; visibly-a-little-off beats silently-huge.
    expect(timelineOffsetMs(15_013, 9.232)).toBe(2000);
  });

  it('disables itself on non-finite or nonsense durations', () => {
    // WebM reports Infinity until seeked to the end.
    expect(timelineOffsetMs(5000, Infinity)).toBe(0);
    expect(timelineOffsetMs(5000, NaN)).toBe(0);
    expect(timelineOffsetMs(5000, 0)).toBe(0);
    expect(timelineOffsetMs(5000, -3)).toBe(0);
  });
});
