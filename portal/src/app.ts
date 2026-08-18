/**
 * Phase 0 POC wiring (PRD §4).
 * Camera → MediaPipe → portal geometry → gesture trigger → canvas composite.
 */

import { loadConfig, saveConfig, type Config } from './config';
import { DIMENSIONS } from './dimensions';
import {
  CONTACT_MODES,
  normalizedArea,
  normalizedGap,
  sideGaps,
  smoothPortal,
  type PortalPoints,
} from './geometry';
import { HandTracker } from './handTracking';
import { Renderer, PORTAL_GREEN } from './renderer';
import { DebugPanel } from './debugPanel';
import {
  GesturalTransition,
  PortalTransition,
  TRANSITION_KINDS,
  TRANSITION_TIMINGS,
  applyTransition,
  type TransitionSpec,
} from './portalTransition';
import { CloseOpenTrigger } from './triggers/closeOpenTrigger';
import type { GestureTrigger } from './triggers/types';
import { LucySession, resolveApiKey } from './lucy';
import { sessionLog } from './sessionLog';
import { DelayBuffer } from './delayBuffer';
import { StreamRecorder } from './recorder';

const PORTAL_FADE_MS = 120;
/** EMA on d(gap)/dt — the raw derivative is far too noisy to threshold on. */
const VELOCITY_ALPHA = 0.35;
/**
 * Ceiling on the auto-tracked delay. Past this the preview is unusable to
 * perform against, and a Δ this large means something is wrong that a buffer
 * should not paper over.
 */
const MAX_SYNC_MS = 1200;

export interface Hud {
  status: HTMLElement;
  dimension: HTMLElement;
  counter: HTMLElement;
  toast: HTMLElement;
  /** Lucy connection state. Stays hidden in camera-only mode. */
  lucy: HTMLElement;
}

export interface AppOptions {
  /** Connect Lucy at start. False runs camera-only, which costs nothing. */
  useLucy?: boolean;
}

export class App {
  private cfg: Config = loadConfig();
  private tracker = new HandTracker();
  private renderer: Renderer;
  private panel: DebugPanel;
  private trigger: GestureTrigger = new CloseOpenTrigger();
  private transition = new PortalTransition();
  private gesturalTransition = new GesturalTransition();
  private delay = new DelayBuffer();

  private video = document.createElement('video');
  private stream: MediaStream | null = null;

  private smoothed: PortalPoints | null = null;
  private opacity = 0;
  private lastPortalAt = -Infinity;

  private prevGap = 0;
  private gapVelocity = 0;
  private lastFrameAt = 0;
  private fps = 0;

  private dimensionIndex = 0;
  private switches = 0;
  /** When the current gestural hold began, for the debug readout. */
  private holdStartedAt = 0;
  private running = false;
  private toastTimer = 0;

  private lucy: LucySession | null = null;
  private wantLucy: boolean;
  /** Next time to sample our own render rate into the session log. */
  private nextPerfLogAt = 0;
  /** Rolling max of `detectForVideo` cost, reset each time it is logged. */
  private detectMsPeak = 0;
  /** Last time hands were seen, for the idle-disconnect cost guard. */
  private lastHandsAt = 0;
  /** Delay currently applied, ms. Moves toward the target under a slew limit. */
  private syncApplied = 0;
  /** When the pipeline first read as calibrated, for the warm-up fade-in. */
  private calibratedAt: number | null = null;
  /** Throttle for the HUD chip — it carries a live number now. */
  private nextChipAt = 0;
  /** Dimension index already requested from Lucy, to avoid a duplicate send. */
  private promptRequestedFor = -1;
  /** When that request went out — the head start the swap gets, in the log. */
  private promptRequestedAt = 0;
  /**
   * Raw stream recordings for offline analysis. The endpoint only exists on the
   * dev server, so outside `npm run dev` these stay inert rather than buffering
   * video nobody can write.
   */
  private camRecorder: StreamRecorder | null = null;
  private lucyRecorder: StreamRecorder | null = null;

  private hud: Hud;

  constructor(root: HTMLElement, hud: Hud, options: AppOptions = {}) {
    this.hud = hud;
    this.wantLucy = options.useLucy ?? false;

    const canvas = document.createElement('canvas');
    canvas.className = 'stage';
    root.append(canvas);
    this.renderer = new Renderer(canvas);

    this.panel = new DebugPanel(this.cfg, () => {
      this.switches = 0;
      this.trigger.reset();
    });
    document.body.append(this.panel.el);
    this.applyPanelVisibility();

    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  async start(): Promise<void> {
    this.setStatus('Requesting camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: this.cfg.captureWidth },
        height: { ideal: this.cfg.captureHeight },
        frameRate: { ideal: this.cfg.captureFps },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    await waitForMetadata(this.video);
    this.renderer.resize(this.video.videoWidth, this.video.videoHeight);

    // What the camera actually granted, which is rarely exactly what was asked
    // for — and it decides the uplink bitrate, so it belongs in the log next to
    // any latency complaint.
    sessionLog.log('camera', {
      requested: `${this.cfg.captureWidth}×${this.cfg.captureHeight}@${this.cfg.captureFps}`,
      granted: this.stream.getVideoTracks()[0]?.getSettings(),
      videoSize: `${this.video.videoWidth}×${this.video.videoHeight}`,
    });

    this.setStatus('Loading hand model…');
    await this.tracker.init(this.cfg);

    this.setStatus('');
    this.running = true;
    this.lastFrameAt = performance.now();
    this.lastHandsAt = performance.now();
    requestAnimationFrame((t) => this.loop(t));

    // Deliberately not awaited: the camera loop should be running and tracking
    // hands during Lucy's 4–5s cold start, not frozen behind it. The portal
    // shows its dimension colour until the first frame decodes.
    if (this.wantLucy) void this.connectLucy();
  }

  stop(): void {
    this.running = false;
    this.stopRecording();
    this.lucy?.disconnect();
    this.lucy = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.tracker.close();
  }

  /** Connect Lucy, or report why not. Safe to call when already connected. */
  async connectLucy(): Promise<void> {
    if (this.lucy || !this.stream) return;
    const { key, source } = resolveApiKey();
    if (!key) {
      this.setLucyChip('no API key', 'error');
      this.toast('No API key — add one to portal/.env.local');
      return;
    }

    const session = new LucySession({
      apiKey: key,
      // Connect straight into the current dimension rather than dimension #1,
      // so reconnecting mid-session doesn't silently rewind the universe.
      initialPrompt: DIMENSIONS[this.dimensionIndex].prompt,
      codec: this.cfg.lucyCodec,
      passthrough: this.cfg.lucyPassthrough,
      onPhase: (phase, detail) => this.setLucyChip(detail, phase),
    });
    this.lucy = session;
    this.setLucyChip(`connecting (key: ${source})`, 'connecting');

    try {
      await session.connect(this.stream);
    } catch (err) {
      // Hang up before dropping the reference. A connect that threw part-way
      // can still have left a session open on Decart's side, and once `this.lucy`
      // is null nothing can reach it to disconnect — it would bill until the tab
      // closed.
      session.disconnect();
      this.lucy = null;
      const msg = err instanceof Error ? err.message : String(err);
      this.setLucyChip('failed', 'error');
      this.toast(`Lucy: ${msg}`);
      console.error('Lucy connect failed', err);
      return;
    }

    this.toast(
      `Lucy live · ${this.cfg.lucyCodec}${this.cfg.lucyPassthrough ? ' · PASSTHROUGH (no model)' : ''}${this.cfg.recordStreams ? ' · recording' : ''}`,
    );

    // Deliberately outside the try above. Recording is diagnostics; it must
    // never be able to fail the session it is observing — which is exactly what
    // happened on 2026-08-17, when MediaRecorder threw on a remote track that
    // had not yet produced a frame and a healthy paid session was reported as
    // a connection failure and abandoned mid-flight.
    this.startRecording();
  }

  disconnectLucy(reason = 'disconnected'): void {
    if (!this.lucy) return;
    this.calibratedAt = null;
    this.stopRecording();
    this.lucy.disconnect();
    this.lucy = null;
    this.setLucyChip(reason, 'idle');
  }

  private loop(t: number): void {
    if (!this.running) return;

    const dt = Math.min((t - this.lastFrameAt) / 1000, 0.25);
    this.lastFrameAt = t;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.1;

    const hands = this.tracker.detect(this.video, t, this.cfg);

    if (hands.portal) {
      this.smoothed = smoothPortal(this.smoothed, hands.portal, this.cfg.emaAlpha);
      this.lastPortalAt = t;
    } else if (t - this.lastPortalAt > this.cfg.lostResetMs) {
      // Long dropout: forget the smoothing history so the portal snaps cleanly
      // to the hands next time instead of sliding in from a stale position.
      this.smoothed = null;
    }

    const handsPresent = hands.portal !== null;
    const gap = this.smoothed
      ? normalizedGap(this.smoothed, this.cfg.contactMode, this.cfg.worstSideBias)
      : this.prevGap;
    const area = this.smoothed ? normalizedArea(this.smoothed) : 0;

    if (handsPresent && dt > 0) {
      const instant = (gap - this.prevGap) / dt;
      this.gapVelocity += (instant - this.gapVelocity) * VELOCITY_ALPHA;
    } else {
      this.gapVelocity = 0;
    }
    this.prevGap = gap;

    const result = this.trigger.update(
      { t, dt, handsPresent, gap, area, gapVelocity: this.gapVelocity },
      this.cfg,
    );

    // The trigger only *starts* the transition; the dimension actually changes
    // when the portal is fully shut, so the swap is never seen mid-flight (§4.1).
    // Under `gestural` the two halves are driven separately: the close collapses
    // it, and the hands parting is what reopens it.
    // Send the prompt the moment the close is *detected*, not when the collapse
    // animation finishes — Lucy needs every millisecond of head start it can
    // get (~2.2s from request to visible change, measured 2026-08-16), and the
    // animation is 110ms of pure waiting we were spending for nothing.
    //
    // Safe to move here because this is the same debounced, cooldown-guarded
    // event that starts the collapse; it is not an earlier *guess* that the
    // close is coming. The visible dimension — colour, HUD — still changes at
    // zero closure below, so nothing on screen moves ahead of the animation.
    if (result.advance) this.requestDimension((this.dimensionIndex + 1) % DIMENSIONS.length, t);

    const gestural = this.cfg.transitionTiming === 'gestural';
    if (gestural) {
      if (result.advance) this.gesturalTransition.collapse(t);
      if (result.release) this.gesturalTransition.release(t);
      // The portal stays shut for as long as the hands do — deliberately with no
      // time limit, because holding it closed is a performance choice. The only
      // thing that must force it open is *losing* the hands: the trigger drops to
      // IDLE after `lostResetMs`, and without this the portal would stay
      // collapsed on screen with nothing left to reopen it.
      else if (this.gesturalTransition.holding && result.state === 'IDLE') {
        this.gesturalTransition.release(t);
      }
    } else if (result.advance) {
      this.transition.trigger(t);
    }

    const spec: TransitionSpec = {
      kind: this.cfg.transitionKind,
      collapseMs: this.cfg.collapseMs,
      holdMs: this.cfg.holdMs,
      maxHoldMs: this.cfg.maxHoldMs,
      reopenMs: this.cfg.reopenMs,
      overshoot: this.cfg.reopenOvershoot,
      twistDegrees: this.cfg.twistDegrees,
    };
    const transition = gestural
      ? this.gesturalTransition.update(t, spec)
      : this.transition.update(t, spec);

    if (transition.swap) {
      this.dimensionIndex = (this.dimensionIndex + 1) % DIMENSIONS.length;
      this.switches++;
      this.holdStartedAt = t;
      sessionLog.log('switch', {
        n: this.switches,
        dimension: DIMENSIONS[this.dimensionIndex].name,
        gap: Number(gap.toFixed(3)),
        // How far ahead of the visible swap the prompt went out. Small next to
        // the ~2.2s it takes to land, but it is free and it is measurable.
        headStartMs: this.promptRequestedAt > 0 ? Math.round(t - this.promptRequestedAt) : 0,
      });
      // Normally already sent on `advance`, above, so this no-ops. It is the
      // fallback for paths that reach a swap without one — a manual `Space`
      // play, or `1`–`4` previewing a transition. `dimensionIndex` has already
      // advanced here, so the target is the dimension now being shown.
      this.requestDimension(this.dimensionIndex, t);
    }

    // Our own render rate, once a second, on the same clock as the SDK's stats.
    //
    // This is not vanity instrumentation. The camera track we hand Lucy is
    // captured by the same page that runs MediaPipe and the compositor, so if
    // this loop is starved the *encoder gets fed fewer frames* — which shows up
    // in the SDK's stats as a low outbound fps with no quality-limitation
    // reason, i.e. looking like a network problem when it is ours. Without this
    // row the two are indistinguishable in the log.
    this.detectMsPeak = Math.max(this.detectMsPeak, hands.detectMs);
    if (t >= this.nextPerfLogAt) {
      sessionLog.log('perf', {
        fps: Number(this.fps.toFixed(1)),
        detectMs: Number(hands.detectMs.toFixed(1)),
        detectPeakMs: Number(this.detectMsPeak.toFixed(1)),
        hands: hands.rawHands.length,
        canvas: `${this.renderer.canvas.width}×${this.renderer.canvas.height}`,
        hidden: document.visibilityState === 'hidden',
      });
      this.detectMsPeak = 0;
      this.nextPerfLogAt = t + 1000;
    }

    // Δ on the HUD chip, not just in the debug panel. It is the number that has
    // driven every decision in this phase, and it was sitting behind a keypress
    // — to the point of being counted by hand off screen recordings instead.
    // Frames alongside ms because that is how it gets checked against a 60fps
    // capture.
    if (this.lucy && t >= this.nextChipAt) {
      this.nextChipAt = t + 500;
      const d = this.lucy.stats.g2gMs;
      const delta =
        this.calibratedAt === null && this.cfg.warmUpBeforeReveal
          ? ' · calibrating…'
          : d != null
            ? ` · ${Math.round(d)}ms (${Math.round((d / 1000) * 60)}f)`
            : ' · measuring…';
      this.setLucyChip(`${this.lucy.phase} · ${this.cfg.lucyCodec}${delta}`, this.lucy.phase);
    }

    // Cost guard: an unattended session bills by the second (§Phase 2).
    if (handsPresent) this.lastHandsAt = t;
    if (
      this.lucy &&
      this.cfg.idleDisconnectMs > 0 &&
      t - this.lastHandsAt > this.cfg.idleDisconnectMs
    ) {
      this.disconnectLucy('idle — disconnected');
      this.toast('Lucy disconnected (idle). Press C to reconnect.');
    }

    // Fade rather than pop when a hand drops out (PRD §2.1).
    const target = handsPresent ? 1 : 0;
    const step = dt / (PORTAL_FADE_MS / 1000);
    this.opacity += Math.max(-step, Math.min(step, target - this.opacity));

    const dimension = DIMENSIONS[this.dimensionIndex];

    // Display-only reshaping. `this.smoothed` — the un-animated portal — is what
    // the trigger above reads, so the animation can never drive the state machine.
    const rendered = this.smoothed
      ? applyTransition(this.smoothed, transition, this.cfg.transitionKind)
      : null;

    // Sync compensation (PRD §2.3 V2). Lucy's frames depict ~730ms ago, so to
    // put all three layers on the same instant we hold the raw feed *and* the
    // portal geometry back to match. Without it the window sits on the live
    // hands while its contents show the past, and the transformed hands inside
    // slide against the real hands bordering it — that seam is the artifact.
    //
    // The price is a preview delayed by the same amount, which is why it is off
    // by default and worth A/B-ing rather than assuming (§2.3, option 4).
    this.updateSyncDelay(dt);

    let base: CanvasImageSource = this.video;
    let shownPortal = rendered;
    let shownOpacity = this.opacity;
    if (this.syncApplied > 0) {
      const w = this.renderer.canvas.width;
      const h = this.renderer.canvas.height;
      this.delay.push(
        this.video, w, h, rendered, this.opacity, t,
        this.syncApplied,
        // The camera's interval, not the render loop's: the buffer stores one
        // copy per distinct camera frame, so that is what sets how many slots
        // a given delay needs. Our loop runs at 60fps against a 30fps camera.
        1000 / Math.max(1, this.cfg.captureFps),
      );
      const s = this.delay.sample(t, this.syncApplied);
      if (s) {
        base = s.image;
        shownPortal = s.portal;
        shownOpacity = s.opacity;
      }
    } else if (this.delay.size > 0) {
      this.delay.reset();
    }

    this.renderer.render(
      {
        video: base,
        hands,
        portal: shownPortal,
        opacity: shownOpacity,
        fill: dimension.color,
        // Falls back to the flat colour whenever Lucy has nothing decoded —
        // cold start, a dropped connection, or camera-only mode. Same path.
        source: this.lucy?.frame ?? null,
        sourceAlpha: this.revealAlpha(t),
        outline: this.outlineStyle(t, dimension.color),
      },
      this.cfg,
    );

    this.hud.dimension.textContent = `${this.dimensionIndex + 1}/${DIMENSIONS.length} · ${dimension.name}`;
    this.hud.dimension.style.color = dimension.color;
    this.hud.counter.textContent = `${this.switches} switches`;

    this.panel.update({
      fps: this.fps,
      detectMs: hands.detectMs,
      state: result.state + (result.closed ? ' (closed)' : ''),
      gap,
      area,
      gapVelocity: this.gapVelocity,
      hands: `${hands.left ? 'L' : '·'}${hands.right ? 'R' : '·'} (${hands.rawHands.length})`,
      dimension: dimension.name,
      switches: this.switches,
      extra: {
        trigger: this.trigger.name,
        ...this.trigger.debug(),
        // All three contact modes at once, so picking one is observation rather
        // than guesswork — they are on different scales (§2.2.1).
        'gap s/p/a': this.smoothed
          ? CONTACT_MODES.map((m) =>
              normalizedGap(this.smoothed!, m, this.cfg.worstSideBias).toFixed(2),
            ).join(' / ')
          : '—',
        // The two sides behind that number. A lopsided pair here is the case the
        // worst-side bias exists to reject (§2.2.1).
        'sides a/b': this.smoothed
          ? (() => {
              const s = sideGaps(this.smoothed!, this.cfg.contactMode, this.cfg.worstSideBias);
              return `${s.a.toFixed(2)} / ${s.b.toFixed(2)}`;
            })()
          : '—',
        // Timing shown next to the phase: a portal reopening on its own is
        // either `timed` (a clock) or `gestural` + a `maxHoldMs` cap, and this
        // is what tells the two apart at a glance.
        transition: `${transition.phase} (${this.cfg.transitionTiming})`,
        closure: transition.closure.toFixed(2),
        held:
          transition.phase === 'hold'
            ? `${((t - this.holdStartedAt) / 1000).toFixed(1)}s${this.cfg.maxHoldMs > 0 ? ` / ${(this.cfg.maxHoldMs / 1000).toFixed(1)}s cap` : ''}`
            : '—',
        ...this.lucyReadouts(),
      },
    });

    requestAnimationFrame((next) => this.loop(next));
  }

  /**
   * The Phase 1 numbers. Δ (`g2gMs`) comes from the SDK's `stats` event, never
   * from `onConnectionQuality`, which is debounced and would sit stale (§2.3.1).
   *
   * `since prompt` is the one to watch for PRD §7's open question — how long
   * Lucy takes to *visibly* settle after a `setPrompt`. The ack tells you the
   * request landed; only your eyes tell you the pixels changed, so this counts
   * up beside the portal while you watch it turn over.
   */
  private lucyReadouts(): Record<string, string> {
    if (!this.lucy) return { lucy: this.wantLucy ? 'disconnected' : 'off (camera only)' };
    const s = this.lucy.stats;
    const b = s.breakdown;
    const since = this.lucy.msSincePrompt(performance.now());
    const ack = this.lucy.promptAckMs;
    return {
      lucy: `${this.lucy.phase} · ${this.cfg.lucyCodec}${this.lucy.frame ? '' : ' (no frames yet)'}`,
      'Δ g2g': s.g2gMs != null ? `${Math.round(s.g2gMs)}ms (p90 ${fmtMs(s.p90Ms)}, n=${s.sampleCount})` : 'measuring…',
      ttff: fmtMs(s.ttffMs ?? this.lucy.localTtffMs),

      // The breakdown. Read top to bottom, it follows a frame's journey:
      // our encoder → the wire → their model → our jitter buffer → our decoder.
      // Whichever row is big is the one worth attacking; `unaccounted` being
      // big means it is Decart's inference and not ours to fix.
      '↑ encode': fmtMs(b.encodeMs),
      '↑ limited by': b.limitedBy ?? '—',
      '↑ sending': b.outboundKbps != null
        ? `${b.outboundKbps}kbps${b.targetKbps != null ? ` / ${b.targetKbps} target` : ''} · ${b.outboundFps?.toFixed(0) ?? '?'}fps ${b.outboundSize ?? ''}`
        : '—',
      '↔ rtt': fmtMs(b.rttMs),
      '↔ path': b.path ?? '—',
      '≈ unaccounted': b.unaccountedMs != null ? `${Math.round(b.unaccountedMs)}ms (inference)` : '—',
      '↓ jitter buf': b.jitterTargetMs != null
        ? `${Math.round(b.jitterTargetMs)}ms target / ${fmtMs(b.jitterAvgMs)} avg`
        : '—',
      '↓ decode': b.decodeMs != null ? `${fmtMs(b.decodeMs)} (${b.decoder ?? '?'})` : '—',
      '↓ inbound': b.inboundFps != null
        ? `${b.inboundFps.toFixed(0)}fps${b.freezes ? ` · ${b.freezes} freezes` : ''}`
        : '—',

      'prompt ack': ack != null ? `${Math.round(ack)}ms` : since != null ? 'pending…' : '—',
      'since prompt': since != null ? `${(since / 1000).toFixed(1)}s` : '—',
      billed: `${s.secondsUsed.toFixed(0)}s`,
      log: `${sessionLog.size} entries`,
      rec: this.camRecorder?.active
        ? `cam ${mb(this.camRecorder.bytesWritten)} · lucy ${mb(this.lucyRecorder?.bytesWritten ?? 0)}`
        : this.cfg.recordStreams
          ? 'idle'
          : 'off',
      // Whether compensation is actually delivering the delay it was asked
      // for. A capacity below the request means the ring ran out of frames at
      // this frame rate, and the composite is under-delayed rather than
      // aligned — silently, unless it is shown.
      // Where the reveal is: 0% = flat colour hiding the old dimension, 100% =
      // fully live. If it reaches 100% before the portal reopens, the change
      // was masked completely.
      reveal: this.cfg.revealFromColor
        ? (() => {
            const seen = this.lucy?.promptVisibleAt ?? null;
            const pct = Math.round(this.revealAlpha(performance.now()) * 100);
            const how = seen === null ? 'waiting' : seen > 0 ? 'detected' : 'no stream';
            return `${pct}% (${how})`;
          })()
        : 'off (cut straight to stream)',
      'sync Δ': this.cfg.syncMode === 'off'
        ? 'off (live composite)'
        : `${this.cfg.syncMode} · ${Math.round(this.syncApplied)}ms applied · ${Math.round(this.delay.capacityMs)}ms held (${this.delay.size}f)`,
      ...(s.queue ? { queue: `${s.queue.position}/${s.queue.size}` } : {}),
      ...(this.lucy.error ? { 'lucy error': this.lucy.error } : {}),
    };
  }

  private setLucyChip(text: string, phase: string): void {
    this.hud.lucy.textContent = `lucy: ${text}`;
    this.hud.lucy.classList.remove('hidden');
    this.hud.lucy.dataset.phase = phase;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const key = e.key.toLowerCase();
    if (key === 'd') {
      this.cfg.showPanel = !this.cfg.showPanel;
      this.applyPanelVisibility();
    } else if (key === 'l') {
      this.cfg.showLandmarks = !this.cfg.showLandmarks;
    } else if (key === 'r') {
      this.switches = 0;
      this.trigger.reset();
      this.transition.reset();
      this.gesturalTransition.reset();
    } else if (key === 'g') {
      sessionLog.download();
      this.toast(`saved ${sessionLog.size} log entries`);
    } else if (key === 'c') {
      // Manual connect/disconnect. Explicit rather than automatic, because the
      // session bills per second and camera-only is free.
      if (this.lucy) {
        this.disconnectLucy();
        this.toast('Lucy disconnected');
      } else {
        this.wantLucy = true;
        this.toast('Connecting Lucy…');
        void this.connectLucy();
      }
    } else if (key === 't') {
      const timings = TRANSITION_TIMINGS;
      const next = timings[(timings.indexOf(this.cfg.transitionTiming) + 1) % timings.length];
      this.cfg.transitionTiming = next;
      saveConfig(this.cfg);
      this.panel.syncInputs();
      this.transition.reset();
      this.gesturalTransition.reset();
      this.toast(`timing: ${next}`);
    } else if (e.code === 'Space') {
      // Manual advance — plays the transition without needing the gesture, so you
      // can compare variants back to back with your hands held still. Under
      // `gestural` a tap collapses and a second tap reopens, which is the point.
      e.preventDefault();
      this.playTransition();
    } else if (key >= '1' && key <= String(TRANSITION_KINDS.length)) {
      this.cfg.transitionKind = TRANSITION_KINDS[Number(key) - 1];
      saveConfig(this.cfg);
      this.panel.syncInputs();
      this.toast(this.cfg.transitionKind);
      // Play it immediately so the variant can be judged the moment it is picked.
      this.playTransition();
    }
  }

  /**
   * Move the applied delay toward whatever the current mode asks for.
   *
   * Deliberately continuous rather than a one-shot calibration at startup: Δ
   * was measured climbing from 588ms to a 635ms plateau over ~30s, so a single
   * early reading would lock in a value that is wrong and getting wronger. The
   * slew limit is what keeps that tracking invisible — see `syncSlewMsPerSec`.
   */
  private updateSyncDelay(dt: number): void {
    let target = 0;
    if (this.cfg.syncMode === 'manual') {
      target = this.cfg.syncDelayMs;
    } else if (this.cfg.syncMode === 'auto') {
      const stats = this.lucy?.stats;
      // Wait for a few samples: the first g2g readings are noisy, and this
      // drives what is on screen.
      if (stats?.g2gMs != null && stats.sampleCount >= 20) {
        target = Math.min(MAX_SYNC_MS, Math.max(0, stats.g2gMs));
      } else {
        // No measurement yet — hold whatever is applied rather than snapping to
        // zero, which would undo a converged delay every time the stream blips.
        target = this.syncApplied;
      }
    }

    // Calibrated = Δ is being measured *and* the applied delay has caught up
    // with it. Both halves matter: a measurement we have not finished acting on
    // still shows a sliding seam.
    const measuring = this.cfg.syncMode !== 'auto' || (this.lucy?.stats.sampleCount ?? 0) >= 20;
    const converged = Math.abs(target - this.syncApplied) < 25;
    if (measuring && converged && this.calibratedAt === null && this.lucy?.frame) {
      this.calibratedAt = performance.now();
      sessionLog.log('sync:calibrated', {
        appliedMs: Math.round(this.syncApplied),
        g2gMs: this.lucy?.stats.g2gMs ?? null,
        samples: this.lucy?.stats.sampleCount ?? 0,
      });
    }

    const step = this.cfg.syncSlewMsPerSec * dt;
    const delta = target - this.syncApplied;
    this.syncApplied += Math.max(-step, Math.min(step, delta));
    if (Math.abs(target - this.syncApplied) < 1) this.syncApplied = target;

    // Keep the slider honest under `auto`, so switching to `manual` freezes the
    // current value instead of jumping to a stale one.
    if (this.cfg.syncMode === 'auto') this.cfg.syncDelayMs = Math.round(this.syncApplied);
  }

  /**
   * Record the camera and Lucy streams to disk, in parallel and unmixed.
   *
   * Both start together so the two files cover the same window, which is what
   * makes the offset between them measurable — that offset *is* the thing
   * under investigation, so compositing them first would erase the evidence.
   */
  private startRecording(): void {
    if (!this.cfg.recordStreams || !this.stream || !this.lucy) return;
    // Dev-server only: `/__rec` does not exist in a build, and buffering video
    // with nowhere to send it would just leak memory.
    const endpoint = import.meta.env.DEV ? '/__rec' : null;
    if (!endpoint) return;
    this.camRecorder = new StreamRecorder('camera', sessionLog.sessionId, endpoint);
    this.lucyRecorder = new StreamRecorder('lucy', sessionLog.sessionId, endpoint);
    this.camRecorder.start(this.stream);

    // Re-read `remoteStream` on **every** attempt rather than capturing it once.
    // The SDK builds a *new* `MediaStream` object each time a track is
    // subscribed (`new MediaStream(tracks)` in its media-channel) instead of
    // mutating the existing one, so the object present at connect can be an
    // audio-only stream that never gains a video track. Holding that reference
    // meant retrying against a stream that could not possibly become ready —
    // 40 attempts of `tracks: 0` while video was plainly playing on screen.
    const tryLucy = (attempt: number): void => {
      if (!this.lucyRecorder) return;
      const remote = this.lucy?.remoteStream;
      if (remote && this.lucyRecorder.start(remote)) return;
      if (attempt >= 40) {
        sessionLog.log('record:gave-up', { name: 'lucy', attempts: attempt });
        return;
      }
      window.setTimeout(() => tryLucy(attempt + 1), 250);
    };
    tryLucy(0);
  }

  private stopRecording(): void {
    this.camRecorder?.stop();
    this.lucyRecorder?.stop();
    this.camRecorder = null;
    this.lucyRecorder = null;
  }

  /**
   * Colour and weight of the portal outline, used as the switch's status light
   * (PRD §1.1, the "device" direction — instrumentation styled as part of the
   * fiction rather than bolted on).
   *
   * Green is the resting state — nominal, nothing in flight. The switch then
   * reads as a departure from it and a return:
   *
   * - **in flight** — request sent, no ack. Neutral white, thin. Something is
   *   happening but nothing is confirmed.
   * - **acked** — the server has the prompt. Flashes the *new* dimension's
   *   colour, so the confirmation is felt rather than read. This is the moment
   *   Sne asked for.
   * - **settling** — decays back to green over ~700ms.
   *
   * Returning to green rather than holding the dimension colour keeps green as
   * the portal's identity and makes the colour mean *an event*, not a mode. It
   * also keeps the resting state readable against any dimension: the first
   * dimension's colour is white, so holding it made the resting outline
   * indistinguishable from the in-flight state.
   *
   * The ack and the landing are genuinely different events ~500ms apart, so
   * this is not one transition dressed up as three.
   */
  private outlineStyle(
    t: number,
    dimensionColor: string,
  ): { color: string; width: number; glow: number } {
    const BASE_WIDTH = 2;
    const resting = { color: PORTAL_GREEN, width: BASE_WIDTH, glow: 0 };
    if (!this.lucy || this.promptRequestedAt <= 0) return resting;

    const acked = this.lucy.promptAckedAt;
    if (acked === null) {
      // In flight. Deliberately colourless — the dimension has not been
      // confirmed, so claiming its colour would be lying about the state.
      return { color: 'rgba(255,255,255,0.55)', width: BASE_WIDTH, glow: 0 };
    }

    const flash = Math.max(0, 1 - (t - acked) / 700);
    if (flash <= 0) return resting;
    return {
      color: mixColor(PORTAL_GREEN, dimensionColor, flash, 0.9),
      width: BASE_WIDTH + 2 * flash,
      // Glow only during the flash, and modestly — it is a confirmation, not
      // an alarm.
      glow: 5 * flash,
    };
  }

  /**
   * How much of Lucy's stream to show, 0–1 — the switch reveal (§4.1).
   *
   * The clock starts when the prompt is *requested*, not when the portal
   * reopens, which is what makes a long hold behave correctly: keep your hands
   * together past `revealHoldMs + revealFadeMs` and the portal opens straight
   * onto the settled stream, no fade, exactly the masking the collapse was
   * always meant to provide.
   *
   * Before the first switch `promptRequestedAt` is 0, so this returns 1 and the
   * opening dimension appears as soon as it decodes rather than being held back
   * behind a reveal nobody asked for.
   */
  private revealAlpha(t: number): number {
    // Warm-up gate: hold the colour until the pipeline is calibrated, then fade
    // in. Applied before the switch reveal because it is a different question —
    // "is this worth showing yet" rather than "has the new dimension arrived".
    if (this.cfg.warmUpBeforeReveal && this.lucy) {
      if (this.calibratedAt === null) return 0;
      const warm = Math.min(1, (t - this.calibratedAt) / 400);
      if (warm < 1) return warm;
    }
    if (!this.cfg.revealFromColor || this.promptRequestedAt <= 0) return 1;

    // Preferred: start fading the moment the restyle is actually on screen, so
    // there is no dead colour beyond one 50ms sampling period. The SDK cannot
    // tell us this — `setPrompt` acks receipt, not application — so it comes
    // from watching the pixels (see settleProbe.ts).
    const seen = this.lucy?.promptVisibleAt ?? null;
    let fadeFrom = seen && seen > 0 ? seen : null;

    // Fallback: a timer, for when detection cannot run or misses — a cold
    // start with no frames to compare, or a restyle too subtle to spike. It is
    // a ceiling on the wait, not the normal path.
    if (fadeFrom === null) {
      const elapsed = t - this.promptRequestedAt;
      if (elapsed <= this.cfg.revealHoldMs) return 0;
      fadeFrom = this.promptRequestedAt + this.cfg.revealHoldMs;
    }

    if (this.cfg.revealFadeMs <= 0) return 1;
    return Math.min(1, Math.max(0, (t - fadeFrom) / this.cfg.revealFadeMs));
  }

  /**
   * Ask Lucy for a specific dimension.
   *
   * **The index is passed in rather than derived**, because the two call sites
   * mean different things by "next": at `advance` the counter has not moved yet
   * so the target is `dimensionIndex + 1`, while at the swap it already has, so
   * the target is `dimensionIndex` itself. Computing it internally sent the
   * dimension *after* the one about to be shown, so every switch requested one
   * too far ahead and Lucy rendered a universe the HUD never named.
   *
   * Idempotent per target: `advance` fires once per close and the swap is only
   * a fallback for manual plays, so the second call normally no-ops. That
   * matters — a duplicate `setPrompt` mid-restyle risks restarting it.
   */
  private requestDimension(index: number, t: number): void {
    if (this.promptRequestedFor === index) return;
    this.promptRequestedFor = index;
    this.promptRequestedAt = t;
    // Not awaited: blocking the render loop on a network ack would stall the
    // collapse animation, and the ack has been seen to take 1.9s.
    void this.lucy?.setPrompt(DIMENSIONS[index].prompt, DIMENSIONS[index].name);
  }

  /** Manual play. Under `gestural` this toggles the two halves. */
  private playTransition(): void {
    const now = performance.now();
    if (this.cfg.transitionTiming !== 'gestural') {
      this.transition.trigger(now);
      return;
    }
    if (this.gesturalTransition.active) this.gesturalTransition.release(now);
    else this.gesturalTransition.collapse(now);
  }

  private toast(text: string): void {
    this.hud.toast.textContent = text;
    this.hud.toast.classList.remove('hidden');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(
      () => this.hud.toast.classList.add('hidden'),
      1100,
    );
  }

  private applyPanelVisibility(): void {
    this.panel.el.classList.toggle('hidden', !this.cfg.showPanel);
  }

  private setStatus(text: string): void {
    this.hud.status.textContent = text;
    this.hud.status.classList.toggle('hidden', !text);
  }
}

/** `#rrggbb` or `rgba(...)` → `[r,g,b]`. */
function parseColor(c: string): [number, number, number] {
  if (c.startsWith('#')) {
    const h = c.slice(1);
    const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
    if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((v) => Number(v.trim()));
    return [r || 0, g || 0, b || 0];
  }
  return [0, 255, 180];
}

/** Blend `from` toward `to` by `amount`, at a fixed alpha. */
function mixColor(from: string, to: string, amount: number, alpha: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  const mix = (i: number) => Math.round(a[i] + (b[i] - a[i]) * amount);
  return `rgba(${mix(0)},${mix(1)},${mix(2)},${alpha})`;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)}MB`;
}

function fmtMs(v: number | null): string {
  return v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}
