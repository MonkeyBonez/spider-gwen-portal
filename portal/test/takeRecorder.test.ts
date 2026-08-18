/**
 * The take's overlay track (PRD §4.5).
 *
 * The load-bearing claim is that overlays can be recorded as *data* and looked
 * up later from `video.currentTime` alone, with no clock correlation. That
 * makes `overlayAt` the join between the two halves of a take, so it is what
 * gets pinned here: nearest-frame selection, and — the part that is easy to get
 * wrong — refusing to answer across a gap.
 */

import { describe, expect, it } from 'vitest';
import { overlayAt, type TakeFrame } from '../src/takeRecorder';
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
