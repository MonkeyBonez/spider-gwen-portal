/**
 * Overlay drawing (PRD §4.2).
 *
 * The load-bearing claim is that an overlay can be *composited*, not just
 * layered: the live app draws it onto its own transparent canvas, while the
 * export draws a video frame and then the overlay onto the same canvas. That
 * only works if drawing never clears, so that is what is pinned here.
 *
 * This shipped broken once. `drawOverlay` opened with a `clearRect`, which is
 * right for a dedicated surface and wrong for a shared one, so saving a take
 * with the outline enabled produced a file containing the outline on black —
 * the video frame was drawn and then immediately erased. Saving *without* the
 * outline was fine, because that path returns the recorded blob untouched and
 * never runs this code, which is what made the bug look so strange.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { drawOverlay, emptyOverlayFrame, type OverlayFrame } from '../src/overlay';

/** Records what was called, and swallows everything a 2D context offers. */
function stubContext(): { calls: string[]; ctx: CanvasRenderingContext2D } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(args.length ? `${name}(${args.length})` : name);
    };
  const ctx = {
    canvas: { width: 1280, height: 720 },
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillText: record('fillText'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
  } as unknown as CanvasRenderingContext2D;
  return { calls, ctx };
}

function portalFrame(): OverlayFrame {
  const frame = emptyOverlayFrame();
  frame.opacity = 1;
  frame.portal = [
    { x: 100, y: 100 },
    { x: 400, y: 100 },
    { x: 400, y: 300 },
    { x: 100, y: 300 },
  ];
  frame.hands = [
    {
      label: 'Left',
      score: 0.93,
      points: Array.from({ length: 21 }, (_, i) => ({ x: i * 3, y: i * 2 })),
    },
  ];
  return frame;
}

beforeAll(() => {
  // `Path2D` is a DOM type and these run in node. Only the constructor and the
  // path-building calls are exercised, so a shell is enough.
  (globalThis as { Path2D?: unknown }).Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
});

describe('drawOverlay', () => {
  /*
   * The regression. The export composites onto one canvas: video frame first,
   * overlay second. A clear between them wipes the picture.
   */
  it('does not clear the canvas', () => {
    for (const layers of [
      { portal: true, landmarks: false },
      { portal: false, landmarks: true },
      { portal: true, landmarks: true },
      { portal: false, landmarks: false },
    ]) {
      const { calls, ctx } = stubContext();
      drawOverlay(ctx, portalFrame(), layers);
      expect(calls).not.toContain('clearRect');
      expect(calls.filter((c) => c.startsWith('clearRect'))).toEqual([]);
    }
  });

  it('draws the outline only when the portal layer is on', () => {
    const on = stubContext();
    drawOverlay(on.ctx, portalFrame(), { portal: true, landmarks: false });
    expect(on.calls).toContain('stroke(1)');

    const off = stubContext();
    drawOverlay(off.ctx, portalFrame(), { portal: false, landmarks: false });
    expect(off.calls).toEqual([]);
  });

  it('draws corner labels with the outline, as one selection', () => {
    const { calls, ctx } = stubContext();
    drawOverlay(ctx, portalFrame(), { portal: true, landmarks: false });
    // Four corners, four labels — they are no longer separable.
    expect(calls.filter((c) => c.startsWith('fillText')).length).toBe(4);
  });

  it('draws nothing at all when every layer is off', () => {
    const { calls, ctx } = stubContext();
    drawOverlay(ctx, portalFrame(), { portal: false, landmarks: false });
    expect(calls).toEqual([]);
  });

  it('skips a faded-out portal, so the outline fades with the window', () => {
    const frame = portalFrame();
    frame.opacity = 0;
    const { calls, ctx } = stubContext();
    drawOverlay(ctx, frame, { portal: true, landmarks: false });
    expect(calls).toEqual([]);
  });

  it('tolerates a hand with no points rather than throwing', () => {
    const frame = portalFrame();
    frame.hands = [{ label: 'Right', score: 0.5, points: [] }];
    const { ctx } = stubContext();
    expect(() => drawOverlay(ctx, frame, { portal: false, landmarks: true })).not.toThrow();
  });
});
