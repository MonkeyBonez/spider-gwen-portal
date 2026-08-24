/**
 * The getting-started tutorial, on its own page so it can be refined for free.
 *
 * The choreography itself lives in `tutorialFlow.ts`, because the app runs the
 * same beats — there, they cover Lucy's 4–5s cold start, so the wait is spent
 * learning the gesture instead of watching a spinner. This page is the *bench*
 * for it: camera-only, a flat white portal, and sliders for the guide geometry,
 * so iterating on the choreography costs no generation-seconds.
 *
 * Everything the app also does is imported from the app's own modules, never
 * reimplemented: the tracker, the renderer, portal smoothing, the close trigger,
 * the transition. If the gesture changes, this page changes with it.
 */

import './style.css';
import './demo.css';
import './tutorialDemo.css';
import { loadConfig, type Config } from './config';
import { DIMENSIONS } from './dimensions';
import {
  normalizedArea,
  normalizedGap,
  smoothPortal,
  type HandPoints,
  type PortalPoints,
} from './geometry';
import { HandTracker } from './handTracking';
import { drawOverlay, type OverlayLayers } from './overlay';
import { GesturalTransition, applyTransition, type TransitionSpec } from './portalTransition';
import { Renderer, type RenderInput } from './renderer';
import { CloseOpenTrigger } from './triggers/closeOpenTrigger';
import { TutorialFlow, type GuideGeometry, type TutorialPhase } from './tutorialFlow';

/** EMA on d(gap)/dt, matching app.ts. */
const VELOCITY_ALPHA = 0.35;

const cfg: Config = loadConfig();

/**
 * The portal's own outline and corner points — the same drawing the app makes,
 * behind the same config flag, so the two pages cannot drift apart.
 *
 * Landmarks stay off regardless of `cfg.showLandmarks`: the tutorial already has
 * a skeleton beat that says "the machine can see you" and then gets out of the
 * way, and a permanent landmark layer would undo that.
 */
const PORTAL_LAYERS: OverlayLayers = { portal: cfg.showPolygonOutline, landmarks: false };

// --- DOM -------------------------------------------------------------------

const root = document.getElementById('demo')!;
root.innerHTML = `
  <header>
    <h1>Getting started — the tutorial</h1>
    <p>
      Three beats: put your hands in the outlines, spread them, then touch your fingers
      and open again. Camera-only — the portal is flat white and each jump just changes
      its colour, so refining this costs no Lucy time. In the real app these same beats
      play while Lucy connects.
    </p>
  </header>

  <div class="gate" id="start">
    <button id="start-btn">Enable camera</button>
    <p class="error hidden" id="error"></p>
  </div>

  <div class="tutorial hidden" id="tutorial">
    <div class="stage-wrap" id="stage-wrap">
      <canvas class="stage" id="stage"></canvas>
      <canvas class="stage overlay" id="guides"></canvas>
      <div class="caption" id="caption"></div>
      <div class="step-dots" id="dots"></div>
    </div>

    <div class="controls">
      <label>hands apart, step 1
        <input type="range" id="near" min="0.02" max="0.2" step="0.005" /><span id="near-v"></span>
      </label>
      <label>hands apart, step 2
        <input type="range" id="far" min="0.1" max="0.4" step="0.005" /><span id="far-v"></span>
      </label>
      <!-- Capped at 0.32: past that the wide-spread guides run off a 16:9 frame. -->
      <label>outline size
        <input type="range" id="height" min="0.08" max="0.32" step="0.005" /><span id="height-v"></span>
      </label>
      <label>lock slop
        <input type="range" id="lock" min="0.2" max="1.2" step="0.02" /><span id="lock-v"></span>
      </label>
      <label>dimming
        <input type="range" id="veil" min="0" max="0.95" step="0.01" /><span id="veil-v"></span>
      </label>
      <button id="restart">Restart tutorial</button>
    </div>

    <p class="readout" id="readout">—</p>
  </div>
`;

const startEl = document.getElementById('start')!;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const errorEl = document.getElementById('error')!;
const tutorialEl = document.getElementById('tutorial')!;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const guideCanvas = document.getElementById('guides') as HTMLCanvasElement;
const captionEl = document.getElementById('caption')!;
const dotsEl = document.getElementById('dots')!;
const readoutEl = document.getElementById('readout')!;

const renderer = new Renderer(canvas);
const guideCtx = guideCanvas.getContext('2d')!;

// --- state -----------------------------------------------------------------

const tracker = new HandTracker();
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;

const trigger = new CloseOpenTrigger();
const transition = new GesturalTransition();
const flow = new TutorialFlow(cfg);

let smoothed: PortalPoints | null = null;
let lastPortalAt = -Infinity;
let prevGap = 0;
let gapVelocity = 0;
let opacity = 0;
let dimension = 0;
let jumps = 0;
let lastFrameAt = 0;
let lastPhase: TutorialPhase | null = null;

function showPhase(phase: TutorialPhase, caption: string): void {
  if (phase === lastPhase) return;
  lastPhase = phase;
  captionEl.textContent = caption;
  captionEl.classList.toggle('soft', phase === 'skeleton');
  // Tutorial over: take the furniture away and leave the portal behind.
  const finished = phase === 'done';
  captionEl.classList.toggle('hidden', finished);
  dotsEl.classList.toggle('hidden', finished);

  const order: TutorialPhase[] = ['place', 'stretch', 'jump'];
  const current = phase === 'skeleton' ? 'place' : phase;
  dotsEl.innerHTML = order
    .map((p, i) => {
      const done = finished || order.indexOf(current) > i;
      const active = current === p;
      return `<span class="dot ${done ? 'done' : ''} ${active ? 'active' : ''}"></span>`;
    })
    .join('');
}

// --- loop ------------------------------------------------------------------

function loop(t: number): void {
  const dt = Math.min((t - lastFrameAt) / 1000, 0.25);
  lastFrameAt = t;

  const hands = tracker.detect(video, t, cfg);
  const handsPresent = !!hands.portal;

  if (hands.portal) {
    smoothed = smoothPortal(smoothed, hands.portal, cfg.emaAlpha);
    lastPortalAt = t;
  } else if (t - lastPortalAt > cfg.lostResetMs) {
    smoothed = null;
  }

  const gap = smoothed ? normalizedGap(smoothed, cfg.contactMode, cfg.worstSideBias) : prevGap;
  const area = smoothed ? normalizedArea(smoothed) : 0;
  if (handsPresent && dt > 0) {
    gapVelocity += ((gap - prevGap) / dt - gapVelocity) * VELOCITY_ALPHA;
  } else {
    gapVelocity = 0;
  }
  prevGap = gap;

  // The gesture is only listened to from step 3 on. Before that a stray close
  // would jump the portal in the middle of a lesson about opening it.
  let swapped = false;
  let closure = 1;
  if (flow.armed) {
    const result = trigger.update({ t, dt, handsPresent, gap, area, gapVelocity }, cfg);
    if (result.advance) transition.collapse(t);
    if (result.release) transition.release(t);
    else if (transition.holding && result.state === 'IDLE') transition.release(t);

    const spec: TransitionSpec = {
      kind: cfg.transitionKind,
      collapseMs: cfg.collapseMs,
      holdMs: cfg.holdMs,
      maxHoldMs: cfg.maxHoldMs,
      reopenMs: cfg.reopenMs,
      overshoot: cfg.reopenOvershoot,
      twistDegrees: cfg.twistDegrees,
    };
    const state = transition.update(t, spec);
    closure = state.closure;
    swapped = state.swap;
  }

  const tut = flow.update({ t, width: canvas.width, height: canvas.height, hands, handsPresent, swapped });
  showPhase(tut.phase, tut.caption);

  if (swapped) {
    dimension = (dimension + 1) % DIMENSIONS.length;
    jumps++;
  }

  // Nothing exists until the skeleton has drawn itself on; after that the portal
  // is a normal hands-follow-me portal, floored by the bloom.
  if (tut.portalOpen) {
    const target = handsPresent ? 1 : 0;
    opacity += Math.max(-dt * 4, Math.min(dt * 4, target - opacity));
    closure = Math.min(closure, tut.bloom);
  }

  const shown =
    smoothed && tut.portalOpen
      ? applyTransition(smoothed, { phase: 'reopen', closure, twist: 0, swap: swapped }, cfg.transitionKind)
      : null;

  const input: RenderInput = {
    video,
    hands,
    portal: shown,
    opacity: tut.portalOpen ? opacity : 0,
    fill: DIMENSIONS[dimension].color,
    source: null,
  };
  renderer.render(input, cfg);

  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  flow.paint(guideCtx, { t, width: canvas.width, height: canvas.height, hands, handsPresent, swapped });
  // The portal outline goes on last, over the dimming, so the window is
  // bordered the same way it will be in the app. `drawOverlay` is the right
  // entry point rather than `renderer.renderOverlay`: it draws without
  // clearing, so it layers on instead of erasing what the tutorial just drew.
  drawOverlay(guideCtx, renderer.buildOverlayFrame(input, cfg, false), PORTAL_LAYERS);

  // `hand` vs `outline` is the dial for `guide.height`: they are the same
  // measure (wrist to middle knuckle, px) on the real hand and on the guide, so
  // tuning the outline to hand size is reading two numbers rather than squinting.
  const seen = [hands.left, hands.right].filter((h): h is HandPoints => !!h);
  const handPx = seen.length ? seen.reduce((sum, h) => sum + h.size, 0) / seen.length : 0;
  const outlinePx = canvas.height * flow.guide.height * 2 * 0.529;

  readoutEl.textContent =
    `step ${tut.phase} · hands ${handsPresent ? 'yes' : 'no'} · ` +
    `hand ${handPx ? `${Math.round(handPx)}px` : '—'} vs outline ${Math.round(outlinePx)}px · ` +
    `gap ${gap.toFixed(2)} · jumps ${jumps} · ${DIMENSIONS[dimension].name}`;

  requestAnimationFrame(loop);
}

// --- controls --------------------------------------------------------------

function slider(id: string, key: keyof GuideGeometry, digits = 3): void {
  const input = document.getElementById(id) as HTMLInputElement;
  const label = document.getElementById(`${id}-v`)!;
  input.value = String(flow.guide[key]);
  label.textContent = flow.guide[key].toFixed(digits);
  input.addEventListener('input', () => {
    flow.guide[key] = Number(input.value);
    label.textContent = flow.guide[key].toFixed(digits);
  });
}

slider('near', 'nearWidth');
slider('far', 'farWidth');
slider('height', 'height');
slider('lock', 'lock', 2);
slider('veil', 'veil', 2);

document.getElementById('restart')!.addEventListener('click', () => {
  const t = performance.now();
  opacity = 0;
  dimension = 0;
  jumps = 0;
  lastPhase = null;
  transition.reset();
  trigger.reset();
  flow.reset(t);
});

// --- start -----------------------------------------------------------------

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting camera…';
  errorEl.classList.add('hidden');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: cfg.captureWidth },
        height: { ideal: cfg.captureHeight },
        frameRate: { ideal: cfg.captureFps },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) return resolve();
      video.onloadedmetadata = () => resolve();
    });

    renderer.resize(video.videoWidth, video.videoHeight);
    guideCanvas.width = video.videoWidth;
    guideCanvas.height = video.videoHeight;

    startBtn.textContent = 'Loading hand model…';
    await tracker.init(cfg);

    startEl.classList.add('hidden');
    tutorialEl.classList.remove('hidden');
    lastFrameAt = performance.now();
    flow.reset(lastFrameAt);
    requestAnimationFrame(loop);
  } catch (err) {
    startBtn.disabled = false;
    startBtn.textContent = 'Enable camera';
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.classList.remove('hidden');
    console.error(err);
  }
});

if (!navigator.mediaDevices?.getUserMedia) {
  startBtn.disabled = true;
  errorEl.textContent = 'No camera API here — needs localhost or https.';
  errorEl.classList.remove('hidden');
}
