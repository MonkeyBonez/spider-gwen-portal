/**
 * Lucy realtime session (PRD Phase 1, §3).
 *
 * Wraps `@decartai/sdk` so the rest of the app only ever sees a `<video>` to
 * draw and a `setPrompt` to call. Everything Decart-specific — connection
 * states, the queue, glass-to-glass stats, generation billing — is handled or
 * surfaced here.
 *
 * Two things this deliberately owns, because getting them wrong costs money or
 * silently produces wrong numbers:
 *
 * - **Billing.** The stream bills per generation-second, so `disconnect()` must
 *   be reachable from every exit path, and `secondsUsed` is always live.
 * - **Δ comes from the `stats` event, not `onConnectionQuality`.** The quality
 *   callback is debounced to fire only when its *verdict* changes, so a HUD fed
 *   from it shows a frozen number for as long as the connection holds steady
 *   (PRD §2.3.1). `stats` ticks about once a second regardless.
 */

import type { RealTimeClient, WebRTCStats } from '@decartai/sdk';
import { sessionLog } from './sessionLog';
import type { LucyCodec } from './lucyCodec';
import { SettleProbe } from './settleProbe';

/**
 * `lucy-2.5` is 1280×720 @30fps, which is exactly our canonical canvas (PRD
 * §7), so the composite needs no letterboxing. `lucy-restyle-2` is 1280×704 —
 * switching to it is not free, it changes the aspect.
 */
const MODEL_NAME = 'lucy-2.5' as const;

export type LucyPhase =
  | 'idle'
  | 'connecting'
  | 'queued'
  | 'live'
  | 'reconnecting'
  | 'error';

/**
 * Where the glass-to-glass time is going, split into legs we can act on.
 *
 * The point of the split is that the three fixes are completely different
 * problems. A backed-up **encoder** means our uplink can't sustain the 3.5Mbps
 * the SDK publishes at, and the answer is to send fewer pixels. A large
 * **jitter buffer** means the receiver is holding frames to smooth out network
 * variance, and the answer is a playout hint or a better network path. A large
 * **unaccounted** remainder is Decart's inference, and the answer is nothing we
 * can write — a different model, or accepting it.
 *
 * Every field is null until the browser has produced the underlying counter.
 */
export interface LatencyBreakdown {
  /** Average encode time per outbound frame (ms). */
  encodeMs: number | null;
  /** Why our encoder is throttling: "bandwidth", "cpu", "none", "other". */
  limitedBy: string | null;
  /** Encoder's target vs what we're actually pushing, kbps. */
  targetKbps: number | null;
  outboundKbps: number | null;
  /** Frames per second we are actually sending. Below ~24 means trouble upstream. */
  outboundFps: number | null;
  /** What we're publishing, e.g. "1280×720". */
  outboundSize: string | null;
  /** Round trip, ms. Prefer the remote-inbound figure, which is usually truer. */
  rttMs: number | null;
  /** "udp" direct vs "relay" (TURN) — a relayed path costs latency. */
  path: string | null;
  /** Receiver jitter buffer — current target, and the cumulative average. */
  jitterTargetMs: number | null;
  jitterAvgMs: number | null;
  /** Average decode time per inbound frame (ms), and which decoder. */
  decodeMs: number | null;
  decoder: string | null;
  /** Inbound frame rate and freezes — a stalling stream reads as latency. */
  inboundFps: number | null;
  freezes: number | null;
  /**
   * g2g minus everything measurable above. Mostly Decart's inference, so a
   * large value here means the delay is not ours to fix.
   */
  unaccountedMs: number | null;
}

export interface LucyStats {
  /** Steady-state glass-to-glass latency (ms) — this is Δ. Null until measured. */
  g2gMs: number | null;
  /** 90th percentile g2g, so a spiky connection is distinguishable from a slow one. */
  p90Ms: number | null;
  /** Connect → first rendered frame (ms). One-shot; expect 4–5s (PRD §2.3.1). */
  ttffMs: number | null;
  /** How many g2g samples are behind the numbers above. */
  sampleCount: number;
  /** Generation seconds billed so far. */
  secondsUsed: number;
  /** Position in the queue, when queued. */
  queue: { position: number; size: number } | null;
  /** Where the g2g time is going. */
  breakdown: LatencyBreakdown;
}

const EMPTY_BREAKDOWN: LatencyBreakdown = {
  encodeMs: null,
  limitedBy: null,
  targetKbps: null,
  outboundKbps: null,
  outboundFps: null,
  outboundSize: null,
  rttMs: null,
  path: null,
  jitterTargetMs: null,
  jitterAvgMs: null,
  decodeMs: null,
  decoder: null,
  inboundFps: null,
  freezes: null,
  unaccountedMs: null,
};

export interface LucyOptions {
  apiKey: string;
  /** Prompt for dimension #1, set at connect so the first frames are never wrong. */
  initialPrompt: string;
  /** Publish codec — decides whether the SDK enables simulcast. See `config.lucyCodec`. */
  codec: LucyCodec;
  onPhase?: (phase: LucyPhase, detail: string) => void;
}

export class LucySession {
  /** Draw this. Null until the first frame has actually decoded. */
  private videoEl: HTMLVideoElement;
  private client: RealTimeClient | null = null;
  private opts: LucyOptions;

  /** The transformed stream as delivered, for recording. Null until connected. */
  private remote: MediaStream | null = null;

  private currentPhase: LucyPhase = 'idle';
  private lastError = '';
  private firstFrameAt = 0;

  private currentStats: LucyStats = {
    g2gMs: null,
    p90Ms: null,
    ttffMs: null,
    sampleCount: 0,
    secondsUsed: 0,
    queue: null,
    breakdown: EMPTY_BREAKDOWN,
  };

  /** Round-trip of the most recent `setPrompt` ack, ms. */
  private lastPromptAckMs: number | null = null;
  /** `performance.now()` of the most recent prompt change, for a settle timer. */
  private lastPromptAt = 0;
  /** Measures how long the output takes to visibly change after a prompt. */
  private settle = new SettleProbe();

  constructor(opts: LucyOptions) {
    this.opts = opts;
    this.videoEl = document.createElement('video');
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;
    this.videoEl.autoplay = true;
  }

  get phase(): LucyPhase {
    return this.currentPhase;
  }

  get error(): string {
    return this.lastError;
  }

  get stats(): LucyStats {
    return this.currentStats;
  }

  get promptAckMs(): number | null {
    return this.lastPromptAckMs;
  }

  /** ms since the last prompt change, or null if none yet. Watch the portal settle. */
  msSincePrompt(now: number): number | null {
    return this.lastPromptAt > 0 ? now - this.lastPromptAt : null;
  }

  /**
   * The decoded stream, or null while it is still empty. The renderer falls
   * back to a flat dimension colour on null, which is what covers the ~4–5s
   * cold start without a hole in the composite.
   */
  /** Lucy's stream itself, for the recorder. */
  get remoteStream(): MediaStream | null {
    return this.remote;
  }

  get frame(): HTMLVideoElement | null {
    const v = this.videoEl;
    return v.readyState >= 2 && v.videoWidth > 0 ? v : null;
  }

  /** ms from connect to the first decoded frame, measured locally. */
  get localTtffMs(): number | null {
    return this.firstFrameAt > 0 ? this.firstFrameAt : null;
  }

  async connect(stream: MediaStream): Promise<void> {
    if (this.client) return;
    this.setPhase('connecting', 'opening session');
    const startedAt = performance.now();

    // Imported here rather than at module scope so the ~500kB LiveKit bundle
    // only loads for a session that is actually going to use it — camera-only
    // mode is free, and its download should be too.
    const { createDecartClient, models } = await import('@decartai/sdk');
    // Route the SDK's internal logging into the session log rather than the
    // console. It goes to a ring buffer, so verbosity is cheap, and its
    // connection-phase detail is exactly what you want when a session is slow
    // to start. `scrub()` keeps any credential out of the file.
    const client = createDecartClient({
      apiKey: this.opts.apiKey,
      logger: {
        debug: (m, d) => sessionLog.log('sdk:debug', { m, ...d }),
        info: (m, d) => sessionLog.log('sdk:info', { m, ...d }),
        warn: (m, d) => sessionLog.log('sdk:warn', { m, ...d }),
        error: (m, d) => sessionLog.log('sdk:error', { m, ...d }),
      },
    });

    try {
      this.client = await client.realtime.connect(stream, {
        model: models.realtime(MODEL_NAME),
        // We mirror in the canvas, so letting the SDK mirror too would flip the
        // portal contents against the mask that frames them. The SDK default is
        // already `false`; stated explicitly so a future edit has to be deliberate.
        mirror: false,
        resolution: '720p',
        preferredVideoCodec: this.opts.codec,
        // `enhance` lets the server rewrite the prompt. Off: we are cycling a
        // fixed library where each dimension has to look the same every time it
        // comes round, and an enhanced rewrite would drift between visits.
        initialState: { prompt: { text: this.opts.initialPrompt, enhance: false } },
        onRemoteStream: (remote) => {
          this.remote = remote;
          this.videoEl.srcObject = remote;
          void this.videoEl.play().catch(() => {
            /* autoplay of a muted stream should not fail, and a failure here
               would only mean a blank portal — not worth tearing the session down */
          });
          this.videoEl.addEventListener(
            'loadeddata',
            () => {
              this.firstFrameAt = performance.now() - startedAt;
              sessionLog.log('lucy:first-frame', {
                localTtffMs: Math.round(this.firstFrameAt),
                size: `${this.videoEl.videoWidth}×${this.videoEl.videoHeight}`,
              });
              this.setPhase('live', 'streaming');
            },
            { once: true },
          );
        },
        onConnectionChange: (state) => {
          if (state === 'reconnecting') this.setPhase('reconnecting', state);
          else if (state === 'disconnected') this.setPhase('idle', state);
          else if (this.currentPhase !== 'live') this.setPhase('connecting', state);
        },
        onQueuePosition: ({ position, queueSize }) => {
          this.currentStats = { ...this.currentStats, queue: { position, size: queueSize } };
          this.setPhase('queued', `queued ${position}/${queueSize}`);
        },
      });
    } catch (err) {
      this.client = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setPhase('error', this.lastError);
      throw err;
    }

    // Δ and its percentile, roughly once a second. `glassToGlass` stays null on
    // runtimes without WebRTC encoded transform; Chrome and Safari both have it.
    //
    // The whole stats object goes to the session log, not just the fields the
    // HUD shows. Latency debugging is retrospective — you want the sample from
    // the moment it felt wrong, and by then the live number has moved on.
    this.client.on('stats', (stats) => {
      sessionLog.log('stats', stats);
      const g = stats.glassToGlass;
      this.currentStats = {
        ...this.currentStats,
        g2gMs: g?.medianMs ?? null,
        p90Ms: g?.p90Ms ?? null,
        ttffMs: g?.ttffMs ?? null,
        sampleCount: g?.sampleCount ?? 0,
        breakdown: breakdownOf(stats),
      };
    });

    // Billing, straight from the source rather than a local clock.
    this.client.on('generationTick', ({ seconds }) => {
      this.currentStats = { ...this.currentStats, secondsUsed: seconds };
    });
    this.client.on('generationEnded', (ended) => {
      sessionLog.log('generationEnded', ended);
      this.currentStats = { ...this.currentStats, secondsUsed: ended.seconds };
    });

    // The SDK's own instrumentation: connection phase breakdown, reconnects,
    // and video stalls. A stall is indistinguishable from latency by eye, so
    // having it labelled in the log is worth a lot.
    this.client.on('diagnostic', (d) => sessionLog.log(`diagnostic:${d.name}`, d.data));
    this.client.on('connectionQuality', (report) => sessionLog.log('connectionQuality', report));
    this.client.on('queuePosition', (q) => sessionLog.log('queuePosition', q));

    this.client.on('error', (err) => {
      sessionLog.log('error', { message: err.message, code: (err as { code?: string }).code });
      this.lastError = err.message;
      this.setPhase('error', err.message);
    });

    sessionLog.log('lucy:connected', {
      model: MODEL_NAME,
      codec: this.opts.codec,
      connectMs: Math.round(performance.now() - startedAt),
      sessionId: this.client.sessionId,
    });
  }

  /**
   * Change dimension. Resolves on the server's ack, and the round trip is
   * recorded — that ack is *not* the same as the output visibly settling, which
   * is the number PRD §7 actually wants, but it is the floor for it.
   */
  /** Set when the probe sees the restyle land, in `performance.now()` terms. */
  private changeSeenAt: number | null = null;

  /**
   * When the last prompt visibly took effect, or null if it has not yet.
   * Driven by pixels, because the SDK has no signal for it — `setPrompt`
   * resolves on receipt, not on application.
   */
  get promptVisibleAt(): number | null {
    return this.changeSeenAt;
  }

  async setPrompt(prompt: string, label?: string): Promise<void> {
    if (!this.client) return;
    const at = performance.now();
    this.lastPromptAt = at;
    this.lastPromptAckMs = null;
    // `label` is carried through to both log lines so a phrasing A/B can be
    // read straight out of the file — "which one was on screen at t=42s" should
    // not require joining against the preceding `switch` entry.
    sessionLog.log('prompt:sent', { label, prompt });
    // Start measuring the *visible* change, which is the number the gesture
    // design actually depends on — the ack below is only the request landing.
    this.changeSeenAt = null;
    if (this.frame) {
      this.settle.start(
        this.frame,
        (samples, detectedAtMs, truncated) =>
          sessionLog.log('prompt:settle', { label, detectedAtMs, truncated, samples }),
        () => {
          this.changeSeenAt = performance.now();
        },
      );
    } else {
      // No frames to watch — a cold start or a dropped stream. Leave it null so
      // the reveal falls back to its timer rather than waiting on a detector
      // that can never fire.
      this.changeSeenAt = 0;
    }
    try {
      await this.client.setPrompt(prompt, { enhance: false });
      this.lastPromptAckMs = performance.now() - at;
      sessionLog.log('prompt:ack', { label, ackMs: Math.round(this.lastPromptAckMs) });
    } catch (err) {
      // A rejected prompt leaves the previous dimension on screen, which is a
      // cosmetic failure — not a reason to drop a paid session.
      this.lastError = err instanceof Error ? err.message : String(err);
      sessionLog.log('prompt:failed', { message: this.lastError });
    }
  }

  disconnect(): void {
    sessionLog.log('lucy:disconnect', { billedSeconds: this.currentStats.secondsUsed });
    this.settle.stop();
    this.client?.disconnect();
    this.client = null;
    this.remote = null;
    this.videoEl.srcObject = null;
    this.firstFrameAt = 0;
    this.currentStats = { ...this.currentStats, queue: null };
    this.setPhase('idle', 'disconnected');
  }

  private setPhase(phase: LucyPhase, detail: string): void {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    sessionLog.log('lucy:phase', { phase, detail });
    this.opts.onPhase?.(phase, detail);
  }
}

/**
 * Split a stats sample into the legs of the latency path.
 *
 * `unaccountedMs` is the interesting one: g2g minus every delay we can name.
 * The SDK's own source puts Decart's server-side pipeline median at ~285ms, so
 * a remainder near that is normal and a remainder far above it means the model
 * is the bottleneck rather than anything on this machine or this network.
 *
 * Note the units. `avgJitterBufferMs` and friends are *cumulative averages
 * since stream start*, so they lag a sudden change; `jitterBufferTargetDelayMs`
 * is the current target and reacts immediately. Both are surfaced because the
 * gap between them is itself the signal that conditions just changed.
 */
function breakdownOf(stats: WebRTCStats): LatencyBreakdown {
  const inb = stats.video;
  const out = stats.outboundVideo;
  const pair = stats.connection.selectedCandidatePairs[0];

  // Prefer remote-inbound RTT: it is the far end's own measurement, and the
  // SDK's types note it is often more accurate than the ICE figure.
  const rttSec = stats.remoteInbound?.roundTripTime ?? stats.connection.currentRoundTripTime;
  const rttMs = rttSec != null ? rttSec * 1000 : null;

  const encodeMs = out?.avgEncodeTimeMs ?? null;
  const jitterTargetMs = inb?.jitterBufferTargetDelayMs ?? null;
  const decodeMs = inb?.avgDecodeTimeMs ?? null;

  const g2g = stats.glassToGlass?.medianMs ?? null;
  const named = [encodeMs, rttMs, jitterTargetMs, decodeMs];
  const unaccountedMs =
    g2g != null && named.every((v) => v != null)
      ? Math.max(0, g2g - (named as number[]).reduce((a, b) => a + b, 0))
      : null;

  return {
    encodeMs,
    limitedBy: out?.qualityLimitationReason ?? null,
    targetKbps: out?.targetBitrateKbps ?? null,
    outboundKbps: out ? Math.round(out.bitrate / 1000) : null,
    outboundFps: out?.framesPerSecond ?? null,
    outboundSize: out ? `${out.frameWidth}×${out.frameHeight}` : null,
    rttMs,
    path: pair ? `${pair.local.candidateType}/${pair.remote.candidateType} ${pair.local.protocol}` : null,
    jitterTargetMs,
    jitterAvgMs: inb?.avgJitterBufferMs ?? null,
    decodeMs,
    decoder: inb?.decoderImplementation ?? null,
    inboundFps: inb?.framesPerSecond ?? null,
    freezes: inb?.freezeCount ?? null,
    unaccountedMs,
  };
}

/**
 * Where the key comes from, in priority order:
 *
 *  1. `VITE_DECART_API_KEY` in `portal/.env.local` — local dev convenience.
 *     Vite inlines it into the bundle, so it must never be set for a deployed
 *     build.
 *  2. localStorage, entered in the UI. This is the path a real user takes
 *     (PRD Phase 2, BYO key) and the one worth testing.
 *
 * The key is never sent anywhere except Decart, and never logged.
 */
const KEY_STORAGE = 'portal.decart.key';

export function resolveApiKey(): { key: string; source: 'env' | 'stored' | 'none' } {
  // The `import.meta.env.DEV` guard is load-bearing, not decoration. Vite
  // replaces it with the literal `false` in a production build, so the whole
  // branch — including the inlined key string — is dropped by dead-code
  // elimination and never reaches `dist/`. Without it, `npm run build` on a
  // machine that has `.env.local` bakes the key into a shippable bundle.
  const fromEnv = import.meta.env.DEV ? import.meta.env.VITE_DECART_API_KEY?.trim() : undefined;
  if (fromEnv) return { key: fromEnv, source: 'env' };
  try {
    const stored = localStorage.getItem(KEY_STORAGE)?.trim();
    if (stored) return { key: stored, source: 'stored' };
  } catch {
    /* storage unavailable — treat as no key */
  }
  return { key: '', source: 'none' };
}

export function storeApiKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* non-fatal — the session just won't survive a reload */
  }
}
