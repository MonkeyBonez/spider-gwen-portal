/**
 * The getting-started tutorial, on its own page so it can be refined for free.
 *
 * ## What it teaches, and why in this order
 *
 * The gesture has two halves that people get wrong in different ways: the
 * *shape* (an L per hand, index and thumb spread, both hands framing a window)
 * and the *motion* (close, then open, to jump). Teaching them together is what
 * makes the gesture feel fiddly, so the tutorial separates them:
 *
 * 1. **Shape, close in.** The feed is dimmed except for two hand-shaped holes.
 *    There is nothing to read — you match your hands to the holes.
 * 2. **Shape, spread out.** The same holes, further apart. The portal is open
 *    by now and follows your hands, so pulling them apart *does* something, and
 *    that is the lesson: the window is yours to size.
 * 3. **Motion.** Touch fingers, open again. The portal jumps.
 *
 * Between 1 and 2 the tracked skeleton draws itself over the user's hands for a
 * beat. It is a receipt — "the machine can see you" — and then it is gone. It
 * is deliberately not a persistent layer; watching your own landmarks is
 * fascinating for five seconds and a distraction forever.
 *
 * ## Why this page exists separately
 *
 * The real point of the tutorial is that it runs *while Lucy connects*, hiding
 * the 4–5s cold start behind something worth watching (the app already fires
 * `connectLucy()` at start, `app.ts:213`). But iterating on choreography while
 * burning generation-seconds is a bad trade, so this page runs camera-only with
 * a flat white portal, and the dev controls below let the geometry be tuned by
 * feel — the same approach as `/tune.html` and `/closure.html`.
 *
 * Everything here that the app also does is *imported* from the app's modules,
 * never reimplemented: the tracker, the renderer, portal smoothing, the close
 * trigger, the transition. If the gesture changes, the tutorial changes with it.
 */

import './style.css';
import './demo.css';
import './tutorialDemo.css';
import { loadConfig, type Config } from './config';
import { DIMENSIONS } from './dimensions';
import {
  dist,
  normalizedArea,
  normalizedGap,
  smoothPortal,
  type HandPoints,
  type PortalPoints,
  type Pt,
} from './geometry';
import { HandTracker } from './handTracking';
import { HAND_CONNECTIONS, PORTAL_GREEN } from './overlay';
import { GesturalTransition, applyTransition, type TransitionSpec } from './portalTransition';
import { Renderer } from './renderer';
import { CloseOpenTrigger } from './triggers/closeOpenTrigger';
import { PALM_LOOP, outlinePair, type OutlinePair, type PoseOutline } from './tutorialPose';

/** EMA on d(gap)/dt, matching app.ts. */
const VELOCITY_ALPHA = 0.35;
/** How long both hands must hold the pose before a step completes. */
const DWELL_MS = 400;
/** How close a fingertip must be to the guide's, as a fraction of hand size. */
const LOCK_TOLERANCE = 0.9;
/** The skeleton flourish. Long enough to read, short enough not to bore. */
const SKELETON_MS = 1500;
/** Portal bloom after the skeleton. */
const POP_MS = 260;
/** Overshoot on the bloom — the portal snaps past full size and settles. */
const POP_OVERSHOOT = 1.15;
/** Silhouette thickness, in hand sizes. Tuned so fingers read as fingers. */
const LIMB_WIDTH = 0.34;

type Phase = 'place' | 'skeleton' | 'stretch' | 'jump' | 'done';

const CAPTIONS: Record<Phase, string> = {
  place: 'Put your hands here to open your portal',
  skeleton: 'Got you',
  stretch: 'Now move into the new outlines to stretch your portal',
  jump: 'Touch your fingers together to jump to the next dimension',
  done: 'That is the whole gesture — every close and open lands somewhere new',
};

const cfg: Config = loadConfig();

/** Guide geometry, as fractions of the frame. Live-editable below. */
const guide = {
  /** Half the horizontal gap between the hands, step 1. */
  nearWidth: 0.07,
  /** ...and step 2. */
  farWidth: 0.21,
  /** Half the vertical span from index tip to thumb tip. Fixed by anatomy. */
  height: 0.15,
  /** How dark the un-cut area gets. */
  veil: 0.78,
};

// --- DOM -------------------------------------------------------------------

const root = document.getElementById('demo')!;
root.innerHTML = `
  <header>
    <h1>Getting started — the tutorial</h1>
    <p>
      Three beats: put your hands in the outlines, spread them, then touch your fingers
      and open again. Camera-only — the portal is flat white and each jump just changes
      its colour, so refining this costs no Lucy time. In the real app this is what plays
      while Lucy connects.
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
      <label>outline size
        <input type="range" id="height" min="0.08" max="0.26" step="0.005" /><span id="height-v"></span>
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

let phase: Phase = 'place';
let phaseAt = 0;
/** When both hands first satisfied the current step, or -1. */
let dwellSince = -1;
/** Set when the portal bloom starts, so opacity and closure can be driven. */
let popAt = -1;
let smoothed: PortalPoints | null = null;
let lastPortalAt = -Infinity;
let prevGap = 0;
let gapVelocity = 0;
let opacity = 0;
let dimension = 0;
let jumps = 0;
let lastFrameAt = 0;
/** Per-hand lock, for guide feedback. */
let leftLocked = false;
let rightLocked = false;

// --- helpers ---------------------------------------------------------------

/** Mirror a capture-space point into screen space, exactly as Renderer does. */
function toScreen(p: Pt): Pt {
  return cfg.mirror ? { x: canvas.width - p.x, y: p.y } : p;
}

function guidesFor(p: Phase): OutlinePair | null {
  const w = canvas.width;
  const h = canvas.height;
  if (p === 'place' || p === 'skeleton') {
    return outlinePair(w, h, guide.nearWidth, guide.height);
  }
  if (p === 'stretch') return outlinePair(w, h, guide.farWidth, guide.height);
  return null;
}

/**
 * Is this hand filling this outline?
 *
 * Both fingertips must be inside a generous radius — generous because the guide
 * is a request for a pose, not a calibration target, and a tutorial that refuses
 * to advance is worse than one that advances a little early.
 */
function fills(hand: HandPoints | null, outline: PoseOutline): boolean {
  if (!hand) return false;
  const r = outline.handSize * LOCK_TOLERANCE;
  return (
    dist(toScreen(hand.index), outline.indexTip) < r &&
    dist(toScreen(hand.thumb), outline.thumbTip) < r
  );
}

/** Matches `easeOutBack` in portalTransition.ts — the app's bloom curve. */
function easeOutBack(p: number, s: number): number {
  const c = 1 - p;
  return 1 + s * Math.pow(c, 3) - s * Math.pow(c, 2) - Math.pow(c, 3);
}

function setPhase(next: Phase, t: number): void {
  phase = next;
  phaseAt = t;
  dwellSince = -1;
  leftLocked = false;
  rightLocked = false;
  captionEl.textContent = CAPTIONS[next];
  captionEl.classList.toggle('soft', next === 'skeleton' || next === 'done');
  renderDots();
}

function renderDots(): void {
  const order: Phase[] = ['place', 'stretch', 'jump'];
  const current = phase === 'skeleton' ? 'place' : phase;
  dotsEl.innerHTML = order
    .map((p, i) => {
      const done = phase === 'done' || order.indexOf(current) > i;
      const active = current === p;
      return `<span class="dot ${done ? 'done' : ''} ${active ? 'active' : ''}"></span>`;
    })
    .join('');
}

// --- guide + skeleton painting ---------------------------------------------

function tracePose(ctx: CanvasRenderingContext2D, points: Pt[], width: number): void {
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  PALM_LOOP.forEach((i, n) => (n === 0 ? ctx.moveTo(points[i].x, points[i].y) : ctx.lineTo(points[i].x, points[i].y)));
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(points[a].x, points[a].y);
    ctx.lineTo(points[b].x, points[b].y);
  }
  ctx.stroke();
}

/**
 * Dim the frame, then cut the hands out of the dimming.
 *
 * The rim is not stroked — stroking the outline of a union of thick lines is
 * not something canvas will do. Instead the silhouette is painted twice: once
 * slightly fat in the rim colour, then punched out at true size with
 * `destination-out`, which leaves the difference behind as a ring and lets the
 * live feed through the middle.
 */
function paintGuides(pair: OutlinePair, veil: number): void {
  const w = guideCanvas.width;
  const h = guideCanvas.height;
  guideCtx.save();
  guideCtx.fillStyle = `rgba(0,0,0,${veil})`;
  guideCtx.fillRect(0, 0, w, h);

  const hands: [PoseOutline, boolean][] = [
    [pair.left, leftLocked],
    [pair.right, rightLocked],
  ];

  for (const [outline, locked] of hands) {
    const width = outline.handSize * LIMB_WIDTH;
    guideCtx.fillStyle = locked ? 'rgba(255,255,255,0.92)' : PORTAL_GREEN;
    guideCtx.strokeStyle = guideCtx.fillStyle;
    tracePose(guideCtx, outline.points, width * 1.13);
  }

  guideCtx.globalCompositeOperation = 'destination-out';
  guideCtx.filter = 'blur(2.5px)';
  guideCtx.fillStyle = '#000';
  guideCtx.strokeStyle = '#000';
  for (const [outline] of hands) {
    tracePose(guideCtx, outline.points, outline.handSize * LIMB_WIDTH);
  }
  guideCtx.restore();
}

/**
 * The skeleton, drawing itself on. Bones arrive in topology order, each easing
 * out from its parent joint, so it reads as the hand being assembled rather
 * than fading in.
 */
function paintSkeleton(rawHands: { label: string; points: Pt[] }[], progress: number): void {
  const drawWindow = 0.55;
  const perBone = drawWindow / HAND_CONNECTIONS.length;
  guideCtx.lineWidth = 2.5;
  guideCtx.lineCap = 'round';

  for (const hand of rawHands) {
    const pts = hand.points.map(toScreen);
    guideCtx.strokeStyle = hand.label === 'Left' ? 'rgba(90,170,255,0.95)' : 'rgba(255,140,90,0.95)';
    guideCtx.fillStyle = guideCtx.strokeStyle;

    guideCtx.beginPath();
    for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
      const [a, b] = HAND_CONNECTIONS[i];
      if (!pts[a] || !pts[b]) continue;
      const local = (progress - i * perBone) / 0.18;
      if (local <= 0) continue;
      const grow = Math.min(1, local);
      guideCtx.moveTo(pts[a].x, pts[a].y);
      guideCtx.lineTo(pts[a].x + (pts[b].x - pts[a].x) * grow, pts[a].y + (pts[b].y - pts[a].y) * grow);
    }
    guideCtx.stroke();

    for (let i = 0; i < pts.length; i++) {
      // A joint appears once the bone that reaches it has arrived.
      const bone = HAND_CONNECTIONS.findIndex(([, b]) => b === i);
      const at = bone < 0 ? 0 : (bone + 1) * perBone;
      if (progress < at) continue;
      guideCtx.beginPath();
      guideCtx.arc(pts[i].x, pts[i].y, 3.2, 0, Math.PI * 2);
      guideCtx.fill();
    }
  }
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

  const pair = guidesFor(phase);

  // --- step progression ---
  if (pair && (phase === 'place' || phase === 'stretch')) {
    leftLocked = fills(cfg.mirror ? hands.left : hands.right, pair.left);
    rightLocked = fills(cfg.mirror ? hands.right : hands.left, pair.right);
    if (leftLocked && rightLocked && handsPresent) {
      if (dwellSince < 0) dwellSince = t;
      if (t - dwellSince >= DWELL_MS) {
        if (phase === 'place') setPhase('skeleton', t);
        else {
          setPhase('jump', t);
          trigger.reset();
        }
      }
    } else {
      dwellSince = -1;
    }
  } else if (phase === 'skeleton' && t - phaseAt >= SKELETON_MS) {
    setPhase('stretch', t);
    popAt = t;
  }

  // --- portal presence ---
  // Nothing exists until the skeleton has finished; after that the portal is a
  // normal hands-follow-me portal.
  const popped = popAt >= 0;
  let closure = 1;
  if (popped) {
    const p = Math.min(1, (t - popAt) / POP_MS);
    closure = easeOutBack(p, POP_OVERSHOOT);
    const target = handsPresent ? 1 : 0;
    opacity += Math.max(-dt * 4, Math.min(dt * 4, target - opacity));
  }

  // --- the jump, step 3 only ---
  let swapped = false;
  if (phase === 'jump' || phase === 'done') {
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
    if (state.swap) {
      dimension = (dimension + 1) % DIMENSIONS.length;
      jumps++;
      swapped = true;
      if (phase === 'jump') setPhase('done', t);
    }
    closure = Math.min(closure, state.closure);
  }

  // --- draw ---
  const shown =
    smoothed && popped
      ? applyTransition(smoothed, { phase: 'reopen', closure, twist: 0, swap: swapped }, cfg.transitionKind)
      : null;

  renderer.render(
    {
      video,
      hands,
      portal: shown,
      opacity: popped ? opacity : 0,
      fill: DIMENSIONS[dimension].color,
      source: null,
    },
    cfg,
  );

  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  if (pair) paintGuides(pair, phase === 'stretch' ? guide.veil * 0.62 : guide.veil);
  if (phase === 'skeleton') paintSkeleton(hands.rawHands, (t - phaseAt) / SKELETON_MS);

  readoutEl.textContent =
    `step ${phase} · hands ${handsPresent ? 'yes' : 'no'} · gap ${gap.toFixed(2)} · ` +
    `jumps ${jumps} · dimension ${DIMENSIONS[dimension].name}`;

  requestAnimationFrame(loop);
}

// --- controls --------------------------------------------------------------

function slider(id: string, key: keyof typeof guide, digits = 3): void {
  const input = document.getElementById(id) as HTMLInputElement;
  const label = document.getElementById(`${id}-v`)!;
  input.value = String(guide[key]);
  label.textContent = guide[key].toFixed(digits);
  input.addEventListener('input', () => {
    guide[key] = Number(input.value);
    label.textContent = guide[key].toFixed(digits);
  });
}

slider('near', 'nearWidth');
slider('far', 'farWidth');
slider('height', 'height');
slider('veil', 'veil', 2);

document.getElementById('restart')!.addEventListener('click', () => {
  const t = performance.now();
  popAt = -1;
  opacity = 0;
  dimension = 0;
  jumps = 0;
  transition.reset();
  trigger.reset();
  setPhase('place', t);
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
    setPhase('place', lastFrameAt);
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
