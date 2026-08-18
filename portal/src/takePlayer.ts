/**
 * Review a take: play it back, toggle layers live, save the version you like.
 *
 * The point of this screen is that **toggling a layer is free**. The composite
 * is a finished video; the overlay is data (see overlay.ts), redrawn on a
 * transparent canvas above it every frame. So a checkbox is a redraw, not a
 * re-encode, and you can flip landmarks on and off while the video is still
 * playing to decide what you actually want.
 *
 * That only stops being free at the moment you save, and even then only
 * sometimes:
 *
 *   - **no overlays** — the composite already *is* the file. Saving hands back
 *     the recorded blob untouched: instant, and with no generation loss from
 *     decoding and re-encoding a video that needed no change.
 *   - **any overlay** — the frames have to be redrawn and re-encoded. That runs
 *     in real time, because a canvas `MediaRecorder` timestamps frames by the
 *     wall clock as they arrive; racing through the source faster than 1× would
 *     produce a file that plays back too fast. A 20s take takes 20s, and the
 *     progress bar says so rather than pretending otherwise.
 */

import {
  drawOverlay,
  overlaysEmpty,
  type OverlayLayers,
} from './overlay';
import { overlayAt, releaseTake, timelineOffsetMs, type Take } from './takeRecorder';
import { sessionLog } from './sessionLog';

/**
 * Default layer selection.
 *
 * The portal is on because it is part of how the thing *looks* — the "device"
 * language of §1.1, not instrumentation. `landmarks` is live tuning only and is
 * never recorded into a take, so it stays false here.
 */
export const DEFAULT_LAYERS: OverlayLayers = { portal: true, landmarks: false };

/**
 * `requestVideoFrameCallback`, if this browser has it.
 *
 * **This is what keeps the overlay on the right frame.** The obvious approach —
 * paint on `requestAnimationFrame` and read `video.currentTime` — quietly does
 * not work: during playback `currentTime` tracks the media clock rather than
 * the frame the compositor is actually showing, so it reports a time slightly
 * ahead of what is on screen and the overlay drawn from it lands a frame or two
 * late. Sne saw it immediately ("the debug frame is just a touch late").
 *
 * `requestVideoFrameCallback` fires once per *presented* frame and hands back
 * that frame's exact `mediaTime`, so the overlay is looked up for the frame the
 * viewer is looking at. It matters twice over: once for the review player, and
 * again for the export, where the same mistake would be encoded permanently
 * into the saved file.
 */
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: { mediaTime: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function frameCallbacks(video: HTMLVideoElement): FrameCallbackVideo | null {
  const v = video as FrameCallbackVideo;
  return typeof v.requestVideoFrameCallback === 'function' ? v : null;
}

const LAYER_ROWS: { key: keyof OverlayLayers; title: string; note: string }[] = [
  { key: 'portal', title: 'Portal outline', note: 'outline, corner points and labels' },
];

export interface TakeReviewHandles {
  close(): void;
}

export function showTakeReview(
  take: Take,
  onClose: () => void,
  layers: OverlayLayers = { ...DEFAULT_LAYERS },
): TakeReviewHandles {
  const root = document.createElement('div');
  root.className = 'review';
  root.innerHTML = `
    <div class="review-panel">
      <header>
        <h2>Your take</h2>
        <span class="muted small" id="rv-meta"></span>
      </header>
      <div class="review-stage">
        <video id="rv-video" playsinline muted loop></video>
        <canvas id="rv-overlay"></canvas>
      </div>
      <div class="review-transport">
        <button id="rv-play" class="icon" aria-label="Play or pause">❚❚</button>
        <input id="rv-seek" type="range" min="0" max="1000" value="0" step="1" />
        <span class="mono small" id="rv-time">0:00</span>
      </div>
      <div class="review-layers">
        <p class="muted small">Layers — toggle while it plays</p>
        <label class="layer locked">
          <input type="checkbox" checked disabled />
          <span><strong>Camera + Lucy</strong><em>the composite, always included</em></span>
        </label>
        <div id="rv-layer-rows"></div>
      </div>
      <p class="review-note muted small" id="rv-note"></p>
      <footer>
        <button id="rv-discard" class="secondary">Discard</button>
        <button id="rv-save">Save video</button>
      </footer>
    </div>
  `;
  document.body.append(root);

  const video = root.querySelector<HTMLVideoElement>('#rv-video')!;
  const canvas = root.querySelector<HTMLCanvasElement>('#rv-overlay')!;
  const ctx = canvas.getContext('2d')!;
  const playBtn = root.querySelector<HTMLButtonElement>('#rv-play')!;
  const seek = root.querySelector<HTMLInputElement>('#rv-seek')!;
  const timeEl = root.querySelector<HTMLElement>('#rv-time')!;
  const metaEl = root.querySelector<HTMLElement>('#rv-meta')!;
  const noteEl = root.querySelector<HTMLElement>('#rv-note')!;
  const saveBtn = root.querySelector<HTMLButtonElement>('#rv-save')!;
  const discardBtn = root.querySelector<HTMLButtonElement>('#rv-discard')!;
  const rows = root.querySelector<HTMLElement>('#rv-layer-rows')!;

  canvas.width = take.width;
  canvas.height = take.height;
  video.src = take.url;

  const seconds = take.durationMs / 1000;
  metaEl.textContent =
    `${take.width}×${take.height} · ${fmtTime(take.durationMs)} · ` +
    `${(take.blob.size / 1e6).toFixed(1)}MB ${take.extension}` +
    (take.truncated ? ' · hit the length cap' : '');
  updateNote();

  for (const row of LAYER_ROWS) {
    const label = document.createElement('label');
    label.className = 'layer';
    label.innerHTML = `
      <input type="checkbox" data-layer="${row.key}" ${layers[row.key] ? 'checked' : ''} />
      <span><strong>${row.title}</strong><em>${row.note}</em></span>
    `;
    label.querySelector('input')!.addEventListener('change', (e) => {
      layers[row.key] = (e.target as HTMLInputElement).checked;
      updateNote();
      paint();
      sessionLog.log('take:layer', { ...layers });
    });
    rows.append(label);
  }

  function updateNote(): void {
    noteEl.textContent = overlaysEmpty(layers)
      ? 'No overlays — saving hands back the original recording untouched, instantly.'
      : `Overlays are drawn on save, so this one re-encodes in real time (~${Math.ceil(seconds)}s).`;
  }

  // A canvas recording carries no duration in its container until it has been
  // seeked to the end, so `video.duration` is Infinity on load. The scrubber
  // uses the recorder's own measurement instead, which is known and exact.
  const durationMs = take.durationMs;

  // The video's clock trails the overlay's (see `timelineOffsetMs`), so every
  // lookup shifts by the difference between the two durations. Known only once
  // the file has told us how long it thinks it is.
  let timelineOffset = 0;
  video.addEventListener('loadedmetadata', () => {
    timelineOffset = timelineOffsetMs(take.durationMs, video.duration);
    sessionLog.log('take:align', {
      takeDurationMs: Math.round(take.durationMs),
      videoDurationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
      offsetMs: Math.round(timelineOffset),
    });
  });

  let raf = 0;
  let vfc = 0;
  let paintFailed = false;
  /** Media time of the last *presented* frame, and when we were told about it. */
  let presentedMs = 0;
  let presentedAt = -Infinity;

  function paint(mediaMs?: number): void {
    // Prefer the presented frame's own media time. `currentTime` is the
    // fallback for browsers without frame callbacks and for the paused and
    // mid-seek states, where no frame is being presented to ask about.
    const ms = mediaMs ?? video.currentTime * 1000;
    try {
      // This canvas is transparent and sits over the <video>, so it owns its
      // own clear — see `drawOverlay`, which does not clear for the export's
      // sake.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const frame = overlayAt(take.frames, ms + timelineOffset);
      if (frame) drawOverlay(ctx, frame, layers);
    } catch (err) {
      // A throw used to kill the loop permanently: `tick` calls `paint` before
      // rescheduling, so one bad frame froze the overlay on screen with the
      // video still running underneath — which reads exactly like a sync bug
      // and is not one. Report once, then keep painting.
      if (!paintFailed) {
        paintFailed = true;
        sessionLog.log('take:paint-failed', { error: String(err), ms: Math.round(ms) });
        console.error('overlay paint failed', err);
      }
    }
    seek.value = String(Math.min(1000, (ms / Math.max(1, durationMs)) * 1000));
    timeEl.textContent = fmtTime(ms);
  }

  // Overlay: driven by presented frames while playing.
  const fcVideo = frameCallbacks(video);
  if (fcVideo) {
    const onFrame = (_now: number, meta: { mediaTime: number }): void => {
      presentedMs = meta.mediaTime * 1000;
      presentedAt = performance.now();
      paint(presentedMs);
      vfc = fcVideo.requestVideoFrameCallback!(onFrame);
    };
    vfc = fcVideo.requestVideoFrameCallback!(onFrame);
  }

  // Transport chrome: driven by rAF, which keeps running when the video is
  // paused and no frames are being presented. It only paints the overlay when
  // frame callbacks have gone quiet, so it cannot fight the exact path above.
  function tick(): void {
    if (!fcVideo || performance.now() - presentedAt > 120) paint();
    else {
      seek.value = String(Math.min(1000, (presentedMs / Math.max(1, durationMs)) * 1000));
      timeEl.textContent = fmtTime(presentedMs);
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  // rAF does not run while the tab is hidden or while a long task holds the
  // main thread, so a seek that lands in one of those windows would leave the
  // overlay showing the frame from wherever the playhead used to be. Painting
  // on `seeked` too means the overlay is correct the moment the video is.
  video.addEventListener('seeked', () => paint());

  playBtn.addEventListener('click', () => {
    if (video.paused) void video.play();
    else video.pause();
  });
  video.addEventListener('play', () => (playBtn.textContent = '❚❚'));
  video.addEventListener('pause', () => (playBtn.textContent = '▶'));
  seek.addEventListener('input', () => {
    video.currentTime = (Number(seek.value) / 1000) * (durationMs / 1000);
    paint();
  });

  void video.play().catch(() => {
    /* autoplay refused — the play button is right there */
  });

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    if (fcVideo && vfc) fcVideo.cancelVideoFrameCallback?.(vfc);
    video.pause();
    video.removeAttribute('src');
    video.load();
    releaseTake(take);
    root.remove();
    window.removeEventListener('keydown', onKey);
    onClose();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  window.addEventListener('keydown', onKey);

  discardBtn.addEventListener('click', () => {
    sessionLog.log('take:discard', { durationMs: Math.round(take.durationMs) });
    close();
  });

  saveBtn.addEventListener('click', () => {
    void (async () => {
      saveBtn.disabled = true;
      const wasPlaying = !video.paused;
      video.pause();
      // Shed every frame of work this screen generates while the export runs.
      // The export encodes 720p in real time; competing with the review's own
      // paint loop for the main thread is how a 15s take once came back as a
      // 9.2s file — the export encoder dropped frames and its muxer compacted
      // the gaps out of the timeline.
      cancelAnimationFrame(raf);
      if (fcVideo && vfc) fcVideo.cancelVideoFrameCallback?.(vfc);
      const started = performance.now();
      try {
        const blob = await exportTake(take, layers, (pct) => {
          saveBtn.textContent = `Rendering ${Math.round(pct * 100)}%`;
        });
        download(blob, filenameFor(take));
        sessionLog.log('take:saved', {
          layers: { ...layers },
          bytes: blob.size,
          reencoded: !overlaysEmpty(layers),
          elapsedMs: Math.round(performance.now() - started),
        });
        saveBtn.textContent = 'Saved ✓';
      } catch (err) {
        sessionLog.log('take:save-failed', { error: String(err) });
        saveBtn.textContent = 'Save failed';
        noteEl.textContent = `Could not render: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        saveBtn.disabled = false;
        window.setTimeout(() => (saveBtn.textContent = 'Save video'), 2500);
        // Resume the loops stopped above.
        raf = requestAnimationFrame(tick);
        if (fcVideo) {
          const onFrame = (_now: number, meta: { mediaTime: number }): void => {
            presentedMs = meta.mediaTime * 1000;
            presentedAt = performance.now();
            paint(presentedMs);
            vfc = fcVideo.requestVideoFrameCallback!(onFrame);
          };
          vfc = fcVideo.requestVideoFrameCallback!(onFrame);
        }
        if (wasPlaying) void video.play();
      }
    })();
  });

  // Dev-only handle on the take's raw data. Alignment between the recorded
  // video and the overlay track has to be checkable from the *data*, not from
  // whatever the canvas happens to be showing — reading pixels off the live
  // player measures the player's paint loop as much as the track.
  if (import.meta.env.DEV) {
    (window as unknown as { __portalTake?: Take }).__portalTake = take;
  }

  return { close };
}

/**
 * Produce the file to save.
 *
 * The no-overlay case returns the recorded blob as-is — see the header. The
 * rest plays the take back at 1× into a fresh canvas with the chosen overlays
 * composited on, recording that. Both the source `<video>` and the export
 * canvas are detached from the document: nothing here should touch what is on
 * screen, so a save can happen while the review player keeps its own playhead.
 */
export async function exportTake(
  take: Take,
  layers: OverlayLayers,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  if (overlaysEmpty(layers)) return take.blob;

  const video = document.createElement('video');
  video.src = take.url;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('take could not be decoded for export'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = take.width;
  canvas.height = take.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');

  // Same re-anchoring as the review player — the source file's clock trails
  // the overlay clock by the recording's dropped time.
  const timelineOffset = timelineOffsetMs(take.durationMs, video.duration);

  const mimeType = take.mimeType;
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm',
    videoBitsPerSecond: 8_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  const compose = (mediaMs: number): void => {
    // No clear: the video frame covers the canvas, and `drawOverlay` goes on
    // top of it. Clearing between the two is what produced an exported file of
    // nothing but the outline on black.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = overlayAt(take.frames, mediaMs + timelineOffset);
    if (frame) drawOverlay(ctx, frame, layers);
    onProgress?.(Math.min(1, mediaMs / Math.max(1, take.durationMs)));
  };

  // Composed per *presented* frame, for the reason in `frameCallbacks`: pairing
  // each source frame with its own `mediaTime` is what keeps the overlay on the
  // right frame. Getting this wrong here is worse than getting it wrong in the
  // player — the player is re-drawn every time it is opened, but a saved file
  // carries the error for good.
  let raf = 0;
  let vfc = 0;
  const fcVideo = frameCallbacks(video);
  const draw = (): void => {
    compose(video.currentTime * 1000);
    raf = requestAnimationFrame(draw);
  };

  // First frame before `start()`, so the stream has content and the recording
  // does not open on a blank canvas.
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  recorder.start();
  if (fcVideo) {
    const onFrame = (_now: number, meta: { mediaTime: number }): void => {
      compose(meta.mediaTime * 1000);
      vfc = fcVideo.requestVideoFrameCallback!(onFrame);
    };
    vfc = fcVideo.requestVideoFrameCallback!(onFrame);
  } else {
    raf = requestAnimationFrame(draw);
  }
  video.currentTime = 0;
  await video.play();

  await new Promise<void>((resolve) => {
    video.onended = () => resolve();
    // A canvas recording's container may report no duration, in which case
    // `ended` still fires at the real end of the media — but a stalled decode
    // would hang the save forever, so the take's own measured length is the
    // backstop. Padded, because the last frames matter.
    window.setTimeout(() => resolve(), take.durationMs + 3000);
  });

  cancelAnimationFrame(raf);
  if (fcVideo && vfc) fcVideo.cancelVideoFrameCallback?.(vfc);
  if (recorder.state !== 'inactive') recorder.stop();
  await finished;
  stream.getTracks().forEach((t) => t.stop());
  video.pause();
  video.removeAttribute('src');
  video.load();
  onProgress?.(1);
  return new Blob(chunks, { type: recorder.mimeType || mimeType });
}

function filenameFor(take: Take): string {
  const stamp = take.startedAtIso.replace(/[:.]/g, '-').replace('Z', '');
  return `portal-${stamp}.${take.extension}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a beat is
  // enough for the fetch to have been kicked off.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
