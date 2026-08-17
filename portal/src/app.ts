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
import { Renderer } from './renderer';
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

const PORTAL_FADE_MS = 120;
/** EMA on d(gap)/dt — the raw derivative is far too noisy to threshold on. */
const VELOCITY_ALPHA = 0.35;

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
  /** Last time hands were seen, for the idle-disconnect cost guard. */
  private lastHandsAt = 0;

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
      onPhase: (phase, detail) => this.setLucyChip(detail, phase),
    });
    this.lucy = session;
    this.setLucyChip(`connecting (key: ${source})`, 'connecting');

    try {
      await session.connect(this.stream);
    } catch (err) {
      this.lucy = null;
      const msg = err instanceof Error ? err.message : String(err);
      this.setLucyChip('failed', 'error');
      this.toast(`Lucy: ${msg}`);
      console.error('Lucy connect failed', err);
    }
  }

  disconnectLucy(reason = 'disconnected'): void {
    if (!this.lucy) return;
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
      // Fired at zero closure, so the portal is fully shut while Lucy settles
      // into the new prompt — which is the whole reason the swap happens here
      // rather than on the trigger (§4.1). Not awaited: blocking the render
      // loop on a network ack would stall the collapse animation itself.
      void this.lucy?.setPrompt(DIMENSIONS[this.dimensionIndex].prompt);
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

    this.renderer.render(
      {
        video: this.video,
        hands,
        portal: rendered,
        opacity: this.opacity,
        fill: dimension.color,
        // Falls back to the flat colour whenever Lucy has nothing decoded —
        // cold start, a dropped connection, or camera-only mode. Same path.
        source: this.lucy?.frame ?? null,
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
    const since = this.lucy.msSincePrompt(performance.now());
    const ack = this.lucy.promptAckMs;
    return {
      lucy: this.lucy.phase + (this.lucy.frame ? '' : ' (no frames yet)'),
      'Δ g2g': s.g2gMs != null ? `${Math.round(s.g2gMs)}ms (p90 ${fmtMs(s.p90Ms)}, n=${s.sampleCount})` : 'measuring…',
      ttff: fmtMs(s.ttffMs ?? this.lucy.localTtffMs),
      'prompt ack': ack != null ? `${Math.round(ack)}ms` : since != null ? 'pending…' : '—',
      'since prompt': since != null ? `${(since / 1000).toFixed(1)}s` : '—',
      billed: `${s.secondsUsed.toFixed(0)}s`,
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

function fmtMs(v: number | null): string {
  return v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}
