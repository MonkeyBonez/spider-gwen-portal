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

import type { RealTimeClient } from '@decartai/sdk';

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
}

export interface LucyOptions {
  apiKey: string;
  /** Prompt for dimension #1, set at connect so the first frames are never wrong. */
  initialPrompt: string;
  onPhase?: (phase: LucyPhase, detail: string) => void;
}

export class LucySession {
  /** Draw this. Null until the first frame has actually decoded. */
  private videoEl: HTMLVideoElement;
  private client: RealTimeClient | null = null;
  private opts: LucyOptions;

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
  };

  /** Round-trip of the most recent `setPrompt` ack, ms. */
  private lastPromptAckMs: number | null = null;
  /** `performance.now()` of the most recent prompt change, for a settle timer. */
  private lastPromptAt = 0;

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
    const client = createDecartClient({ apiKey: this.opts.apiKey });

    try {
      this.client = await client.realtime.connect(stream, {
        model: models.realtime(MODEL_NAME),
        // We mirror in the canvas, so letting the SDK mirror too would flip the
        // portal contents against the mask that frames them. The SDK default is
        // already `false`; stated explicitly so a future edit has to be deliberate.
        mirror: false,
        resolution: '720p',
        // `enhance` lets the server rewrite the prompt. Off: we are cycling a
        // fixed library where each dimension has to look the same every time it
        // comes round, and an enhanced rewrite would drift between visits.
        initialState: { prompt: { text: this.opts.initialPrompt, enhance: false } },
        onRemoteStream: (remote) => {
          this.videoEl.srcObject = remote;
          void this.videoEl.play().catch(() => {
            /* autoplay of a muted stream should not fail, and a failure here
               would only mean a blank portal — not worth tearing the session down */
          });
          this.videoEl.addEventListener(
            'loadeddata',
            () => {
              this.firstFrameAt = performance.now() - startedAt;
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
    this.client.on('stats', ({ glassToGlass }) => {
      this.currentStats = {
        ...this.currentStats,
        g2gMs: glassToGlass?.medianMs ?? null,
        p90Ms: glassToGlass?.p90Ms ?? null,
        ttffMs: glassToGlass?.ttffMs ?? null,
        sampleCount: glassToGlass?.sampleCount ?? 0,
      };
    });

    // Billing, straight from the source rather than a local clock.
    this.client.on('generationTick', ({ seconds }) => {
      this.currentStats = { ...this.currentStats, secondsUsed: seconds };
    });
    this.client.on('generationEnded', ({ seconds }) => {
      this.currentStats = { ...this.currentStats, secondsUsed: seconds };
    });

    this.client.on('error', (err) => {
      this.lastError = err.message;
      this.setPhase('error', err.message);
    });
  }

  /**
   * Change dimension. Resolves on the server's ack, and the round trip is
   * recorded — that ack is *not* the same as the output visibly settling, which
   * is the number PRD §7 actually wants, but it is the floor for it.
   */
  async setPrompt(prompt: string): Promise<void> {
    if (!this.client) return;
    const at = performance.now();
    this.lastPromptAt = at;
    this.lastPromptAckMs = null;
    try {
      await this.client.setPrompt(prompt, { enhance: false });
      this.lastPromptAckMs = performance.now() - at;
    } catch (err) {
      // A rejected prompt leaves the previous dimension on screen, which is a
      // cosmetic failure — not a reason to drop a paid session.
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  disconnect(): void {
    this.client?.disconnect();
    this.client = null;
    this.videoEl.srcObject = null;
    this.firstFrameAt = 0;
    this.currentStats = { ...this.currentStats, queue: null };
    this.setPhase('idle', 'disconnected');
  }

  private setPhase(phase: LucyPhase, detail: string): void {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    this.opts.onPhase?.(phase, detail);
  }
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
