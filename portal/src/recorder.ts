/**
 * Records the camera and Lucy streams side by side, for offline analysis.
 *
 * The point is to be able to answer questions after the fact that no live
 * readout can: how far behind the output actually is on a given motion, what a
 * prompt change looks like frame by frame, whether a stall was the model or the
 * network. The session log says *what the numbers were*; these say *what it
 * looked like*, and the two share a clock.
 *
 * **Both streams are recorded raw, not the composite.** The composite would mix
 * them and destroy exactly the offset we want to measure. (Recording the
 * composite is a separate thing — that is the Phase 1.5 export.)
 *
 * Chunks are uploaded to the dev server as they are produced rather than held
 * and written at the end, for the same reason the session log streams: a tab
 * that crashes or is closed mid-take still leaves its evidence. WebM tolerates
 * this — the first chunk carries the headers and the rest are clusters, so the
 * appended file plays.
 *
 * ## Aligning the two files
 *
 * Both recorders start within a frame of each other and their start times go
 * into the session log, so `startedAt` plus frame number gets you close. For
 * anything tighter, use a *visible event* present in both: a dimension switch
 * is logged with a timestamp and shows up in the Lucy recording as a hard step
 * in image content (see settleProbe.ts). That pairing measures the true
 * end-to-end delay directly, without trusting either clock.
 */

import { sessionLog } from './sessionLog';

/** Upload cadence. Small enough to survive a crash, large enough to be cheap. */
const CHUNK_MS = 2000;

/**
 * Recording bitrate per stream. Deliberately modest — see the note where the
 * recorder is constructed. Analysis wants legible motion, not archival quality.
 */
const BITS_PER_SECOND = 2_000_000;

/**
 * Preference order. vp8 first: it is the most reliably seekable in the tools
 * likely to open these (browsers, ffmpeg, QuickTime via conversion), and
 * analysis wants scrubbing more than it wants compression.
 */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
];

export class StreamRecorder {
  private recorder: MediaRecorder | null = null;
  private name: string;
  private endpoint: string | null;
  private sessionId: string;
  private chunkIndex = 0;
  private bytes = 0;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(name: string, sessionId: string, endpoint: string | null) {
    this.name = name;
    this.sessionId = sessionId;
    this.endpoint = endpoint;
  }

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  get bytesWritten(): number {
    return this.bytes;
  }

  /**
   * Begin recording. **Returns false rather than throwing, always.**
   *
   * This is diagnostics. It must never be able to take down the session it is
   * observing — which it did once: `MediaRecorder.start()` threw on a remote
   * track that had not yet produced a frame, the exception escaped into the
   * caller's connect handler, and a perfectly healthy paid Lucy session was
   * reported as a connection failure and dropped. Hence the whole body in one
   * try, not just the constructor.
   */
  start(stream: MediaStream): boolean {
    if (this.recorder) return true;
    try {
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      if (!mimeType) {
        sessionLog.log('record:unsupported', { name: this.name });
        return false;
      }
      // A remote WebRTC track exists before it carries anything, and recording
      // one in that state is what threw. Refuse early with a reason instead.
      const tracks = stream.getVideoTracks();
      if (tracks.length === 0 || tracks[0].readyState !== 'live' || tracks[0].muted) {
        sessionLog.log('record:not-ready', {
          name: this.name,
          tracks: tracks.length,
          readyState: tracks[0]?.readyState ?? null,
          muted: tracks[0]?.muted ?? null,
        });
        return false;
      }
      // Video only. Audio is not part of any question being asked here, and a
      // second track would complicate frame-accurate alignment for no gain.
      const videoOnly = new MediaStream(tracks);
      // Capped well below what MediaRecorder would choose for 720p. Recording
      // two streams is not free: with both running, outbound frame rate fell
      // from ~27 to ~20 and Δ rose ~30ms (2026-08-17). The measurement should
      // disturb the thing being measured as little as possible, and for reading
      // motion and prompt changes off the footage this is plenty of bitrate.
      const recorder = new MediaRecorder(videoOnly, {
        mimeType,
        videoBitsPerSecond: BITS_PER_SECOND,
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.upload(e.data);
      };
      recorder.onerror = (e) =>
        sessionLog.log('record:error', { name: this.name, error: String(e) });
      recorder.start(CHUNK_MS);
      this.recorder = recorder;
      sessionLog.log('record:start', {
        name: this.name,
        mimeType,
        // The wall clock alongside the monotonic one, so these files can be
        // lined up against anything else recorded at the same time.
        wallClock: new Date().toISOString(),
        track: videoOnly.getVideoTracks()[0]?.getSettings(),
      });
      return true;
    } catch (err) {
      sessionLog.log('record:failed', { name: this.name, error: String(err) });
      this.recorder = null;
      return false;
    }
  }

  stop(): void {
    if (!this.recorder) return;
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch (err) {
      sessionLog.log('record:stop-failed', { name: this.name, error: String(err) });
    }
    this.recorder = null;
    sessionLog.log('record:stop', {
      name: this.name,
      chunks: this.chunkIndex,
      bytes: this.bytes,
    });
  }

  private upload(blob: Blob): void {
    const index = this.chunkIndex++;
    this.bytes += blob.size;
    // Each chunk's arrival time is a coarse timeline for the file — enough to
    // find roughly where in it a logged event falls.
    sessionLog.log('record:chunk', { name: this.name, index, bytes: blob.size });
    if (!this.endpoint) return;
    const url = `${this.endpoint}?session=${encodeURIComponent(this.sessionId)}&name=${encodeURIComponent(this.name)}`;
    // Chained rather than fired in parallel: chunks must land in order, and
    // fetch gives no such guarantee across concurrent calls. Appending a
    // cluster before its predecessor produces a file that will not play.
    this.pending = this.pending
      .then(() => fetch(url, { method: 'POST', body: blob }))
      .catch((err) => sessionLog.log('record:upload-failed', { name: this.name, index, error: String(err) }));
  }
}
