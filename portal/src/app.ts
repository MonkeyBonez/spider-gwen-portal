/**
 * Phase 0 POC wiring (PRD §4).
 * Camera → MediaPipe → portal geometry → gesture trigger → canvas composite.
 */

import { loadConfig, saveConfig, type Config } from './config';
import { DIMENSIONS } from './dimensions';
import {
  normalizedArea,
  normalizedGap,
  smoothPortal,
  type PortalPoints,
} from './geometry';
import { HandTracker } from './handTracking';
import { Renderer } from './renderer';
import { DebugPanel } from './debugPanel';
import {
  PortalTransition,
  TRANSITION_KINDS,
  applyTransition,
  type TransitionSpec,
} from './portalTransition';
import { CloseOpenTrigger } from './triggers/closeOpenTrigger';
import type { GestureTrigger } from './triggers/types';

const PORTAL_FADE_MS = 120;
/** EMA on d(gap)/dt — the raw derivative is far too noisy to threshold on. */
const VELOCITY_ALPHA = 0.35;

export interface Hud {
  status: HTMLElement;
  dimension: HTMLElement;
  counter: HTMLElement;
  toast: HTMLElement;
}

export class App {
  private cfg: Config = loadConfig();
  private tracker = new HandTracker();
  private renderer: Renderer;
  private panel: DebugPanel;
  private trigger: GestureTrigger = new CloseOpenTrigger();
  private transition = new PortalTransition();

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
  private running = false;
  private toastTimer = 0;

  private hud: Hud;

  constructor(root: HTMLElement, hud: Hud) {
    this.hud = hud;

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
    requestAnimationFrame((t) => this.loop(t));
  }

  stop(): void {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.tracker.close();
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
    const gap = this.smoothed ? normalizedGap(this.smoothed) : this.prevGap;
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
    if (result.advance) this.transition.trigger(t);

    const spec: TransitionSpec = {
      kind: this.cfg.transitionKind,
      collapseMs: this.cfg.collapseMs,
      holdMs: this.cfg.holdMs,
      reopenMs: this.cfg.reopenMs,
      overshoot: this.cfg.reopenOvershoot,
      twistDegrees: this.cfg.twistDegrees,
    };
    const transition = this.transition.update(t, spec);

    if (transition.swap) {
      // Phase 1 swaps this for `realtimeClient.setPrompt(nextDimension.prompt)`.
      this.dimensionIndex = (this.dimensionIndex + 1) % DIMENSIONS.length;
      this.switches++;
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
        transition: transition.phase,
        closure: transition.closure.toFixed(2),
      },
    });

    requestAnimationFrame((next) => this.loop(next));
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
    } else if (e.code === 'Space') {
      // Manual advance — plays the full transition without needing the gesture,
      // so you can compare variants back to back with your hands held still.
      e.preventDefault();
      this.transition.trigger(performance.now());
    } else if (key >= '1' && key <= String(TRANSITION_KINDS.length)) {
      this.cfg.transitionKind = TRANSITION_KINDS[Number(key) - 1];
      saveConfig(this.cfg);
      this.panel.syncInputs();
      this.toast(this.cfg.transitionKind);
      // Play it immediately so the variant can be judged the moment it is picked.
      this.transition.trigger(performance.now());
    }
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

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}
