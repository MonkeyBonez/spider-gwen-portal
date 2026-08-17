/**
 * Session log — a recording of everything the Decart SDK and the app report
 * during a run, downloadable as NDJSON.
 *
 * This exists because latency debugging is not something you can do by staring
 * at a live HUD. The interesting question is always "what was happening at the
 * moment it felt bad", and by the time you notice, the numbers have moved on.
 * The SDK emits a full `WebRTCStats` roughly once a second — encode time,
 * quality-limitation reason, jitter buffer, decode time, ICE path — and this
 * keeps every one of them alongside our own events (prompt changes, switches,
 * connects) on a shared clock, so a run can be read back afterwards.
 *
 * **Nothing here ever records the API key.** `scrub()` drops anything that
 * looks like a credential before it reaches the buffer, because these files are
 * meant to be shareable.
 */

/** Ring-buffer cap. Stats tick ~1/s, so this is a few hours of session. */
const MAX_ENTRIES = 20_000;

const SECRET_KEY_PATTERN = /^(api[_-]?key|apikey|key|token|secret|authorization|password)$/i;

export interface LogEntry {
  /** ms since the log was created — a single clock for every source. */
  t: number;
  /** Wall clock, so a downloaded file can be lined up against a screen recording. */
  iso: string;
  kind: string;
  data?: unknown;
}

export class SessionLog {
  private entries: LogEntry[] = [];
  private startedAt = performance.now();
  private startedIso = new Date().toISOString();
  /** Mirror to the devtools console as well as the buffer. */
  echo = false;

  /** Identifies this page load's file on disk. */
  readonly sessionId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 8)}`;
  /** How many entries have already been shipped to the dev server. */
  private flushed = 0;
  private flushTimer = 0;
  private endpoint: string | null = null;

  log(kind: string, data?: unknown): void {
    const entry: LogEntry = {
      t: Math.round(performance.now() - this.startedAt),
      iso: new Date().toISOString(),
      kind,
      ...(data === undefined ? {} : { data: scrub(data) }),
    };
    this.entries.push(entry);
    // Drop from the front rather than clearing: in a long session the recent
    // past is what explains a symptom you just saw.
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (this.echo) console.debug(`[${entry.t}ms] ${kind}`, data ?? '');
  }

  get size(): number {
    return this.entries.length;
  }

  /** Most recent entry of a kind, for readouts that want the latest sample. */
  latest(kind: string): LogEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].kind === kind) return this.entries[i];
    }
    return undefined;
  }

  clear(): void {
    this.entries = [];
    this.flushed = 0;
    this.startedAt = performance.now();
    this.startedIso = new Date().toISOString();
  }

  /**
   * Stream the log to a file on disk via the dev server, so a run is never lost
   * to a reload, a crash, or forgetting to save it — which is precisely the run
   * that mattered. Dev only; there is no such endpoint in a real deployment.
   *
   * @see `sessionLogPlugin` in vite.config.ts, which writes `portal/logs/`.
   */
  startAutoFlush(endpoint: string, intervalMs = 2000): void {
    this.endpoint = endpoint;
    this.flushTimer = window.setInterval(() => void this.flush(), intervalMs);
    // `pagehide` rather than `beforeunload`: it fires in the cases that one
    // misses, and it is the last chance to ship the tail of the session.
    window.addEventListener('pagehide', () => this.flush(true));
    // A hidden tab gets its timers throttled hard, so flush on the way out too.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush(true);
    });
  }

  stopAutoFlush(): void {
    window.clearInterval(this.flushTimer);
    this.endpoint = null;
  }

  /**
   * Ship everything not yet written. `useBeacon` switches to `sendBeacon`,
   * which survives the page going away where `fetch` would be cancelled.
   */
  private async flush(useBeacon = false): Promise<void> {
    if (!this.endpoint) return;
    const pending = this.entries.slice(this.flushed);
    if (pending.length === 0) return;
    // Mark as sent before awaiting, so a slow request can't cause the next tick
    // to send the same entries twice.
    this.flushed = this.entries.length;
    const payload = JSON.stringify({
      sessionId: this.sessionId,
      header: this.flushed === pending.length ? this.header() : undefined,
      lines: pending,
    });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(this.endpoint, new Blob([payload], { type: 'application/json' }));
      } else {
        await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: useBeacon,
        });
      }
    } catch {
      // The dev server going away must never break the app. Rewind so the
      // entries are retried on the next tick rather than silently dropped.
      this.flushed -= pending.length;
    }
  }

  /**
   * NDJSON — one JSON object per line. Chosen over a single JSON array because
   * a truncated or still-growing file is still readable line by line, and
   * because `jq`, `grep` and pandas all take it directly.
   */
  toNdjson(): string {
    return [this.header(), ...this.entries].map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  private header(): LogEntry {
    return {
      t: 0,
      iso: this.startedIso,
      kind: 'session-log-header',
      data: {
        sessionId: this.sessionId,
        userAgent: navigator.userAgent,
        // Which of the two g2g-capable transforms this browser has decides
        // whether latency numbers exist at all (PRD §2.3.1).
        encodedTransform: detectEncodedTransform(),
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
    };
  }

  download(): void {
    const stamp = this.startedIso.replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([this.toNdjson()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portal-session-${stamp}.ndjson`;
    a.click();
    // Revoke on the next tick rather than immediately — Safari has historically
    // cancelled the download if the object URL dies in the same frame.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Whether the SDK will measure glass-to-glass in this browser, mirroring its
 * own `isFrameMetadataRuntimeSupported()` exactly.
 *
 * The subtlety worth preserving: **having `RTCRtpScriptTransform` is not the
 * same as the SDK accepting it.** The SDK only counts that API on
 * *non*-Chromium browsers, and requires `createEncodedStreams` on Chromium —
 * which Chrome still has alongside it. Reporting "the browser has
 * RTCRtpScriptTransform" would therefore claim measurement works on a Chrome
 * that had dropped `createEncodedStreams`, when in fact g2g would be null and
 * every latency number in the log would silently fall back to RTT.
 *
 * If `willMeasure` is ever false, latency debugging is blind and that is the
 * first thing to fix (PRD §2.3.1).
 *
 * Neither API is in the DOM lib types, hence the casts.
 */
function detectEncodedTransform(): Record<string, unknown> {
  const ua = navigator.userAgent.toLowerCase();
  const isChromium = /(?:chrome|chromium|crmo)\//.test(ua) && !/crios\//.test(ua);
  const hasScriptTransform =
    typeof (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== 'undefined';
  const sender = RTCRtpSender?.prototype as { createEncodedStreams?: unknown } | undefined;
  const receiver = RTCRtpReceiver?.prototype as { createEncodedStreams?: unknown } | undefined;
  const hasInsertableStreams =
    typeof sender?.createEncodedStreams !== 'undefined' &&
    typeof receiver?.createEncodedStreams !== 'undefined';
  return {
    isChromium,
    hasScriptTransform,
    hasInsertableStreams,
    willMeasure: (hasScriptTransform && !isChromium) || hasInsertableStreams,
  };
}

/**
 * Remove anything credential-shaped, recursively. Keys are matched by name, and
 * long opaque strings under a suspicious key are replaced wholesale rather than
 * truncated — a prefix of a key is still a leak.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[too deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

/** One log per page load, shared by the app and the Lucy session. */
export const sessionLog = new SessionLog();
