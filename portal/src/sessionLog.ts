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
    this.startedAt = performance.now();
    this.startedIso = new Date().toISOString();
  }

  /**
   * NDJSON — one JSON object per line. Chosen over a single JSON array because
   * a truncated or still-growing file is still readable line by line, and
   * because `jq`, `grep` and pandas all take it directly.
   */
  toNdjson(): string {
    const header = {
      t: 0,
      iso: this.startedIso,
      kind: 'session-log-header',
      data: {
        userAgent: navigator.userAgent,
        // Which of the two g2g-capable transforms this browser has decides
        // whether latency numbers exist at all (PRD §2.3.1).
        encodedTransform: detectEncodedTransform(),
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
    };
    return [header, ...this.entries].map((e) => JSON.stringify(e)).join('\n') + '\n';
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
 * Which WebRTC encoded-transform API this browser has — the same check the SDK
 * gates glass-to-glass measurement on. `none` means `Δ g2g` will read null
 * forever and the latency numbers in the log are RTT-only (PRD §2.3.1).
 *
 * Neither property is in the DOM lib types yet, hence the casts.
 */
function detectEncodedTransform(): string {
  const w = globalThis as { RTCRtpScriptTransform?: unknown };
  if (typeof w.RTCRtpScriptTransform !== 'undefined') return 'RTCRtpScriptTransform';
  const sender = RTCRtpSender?.prototype as { createEncodedStreams?: unknown } | undefined;
  if (typeof sender?.createEncodedStreams !== 'undefined') return 'createEncodedStreams';
  return 'none';
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
