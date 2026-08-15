/**
 * Side-by-side comparison of the switch transitions (PRD §4.1), driven by the
 * real `portalTransition` module and a synthetic pair of hands — so the variants
 * can be judged without a camera, and every panel gets the identical hand motion.
 *
 * The point it is built to answer: does the transition read at all, given that
 * the hands are opening underneath it at the same time?
 */

import './style.css';
import './demo.css';
import { DIMENSIONS } from './dimensions';
import { polygonOrder, type PortalPoints, type Pt } from './geometry';
import {
  PortalTransition,
  TRANSITION_BLURBS,
  TRANSITION_KINDS,
  applyTransition,
  type TransitionKind,
  type TransitionSpec,
} from './portalTransition';

const W = 260;
const H = 260;
/** One synthetic close→open cycle, ms. */
const CYCLE_MS = 2600;

const spec: TransitionSpec = {
  kind: 'iris',
  collapseMs: 110,
  holdMs: 90,
  reopenMs: 240,
  overshoot: 1.1,
  twistDegrees: 90,
};

/** Simulated hands: gap goes wide → shut → wide, like the real gesture. */
function syntheticPortal(phase: number): { portal: PortalPoints; gap: number } {
  // phase 0..1 across one cycle. Shut around the middle.
  const shut = Math.max(0, 1 - Math.abs(phase - 0.5) / 0.28);
  const eased = shut * shut * (3 - 2 * shut); // smoothstep
  const halfWidth = 78 * (1 - eased) + 2 * eased;
  const cx = W / 2;
  const cy = H / 2;
  const halfHeight = 62;
  return {
    portal: {
      lIndex: { x: cx - halfWidth, y: cy - halfHeight },
      rIndex: { x: cx + halfWidth, y: cy - halfHeight },
      rThumb: { x: cx + halfWidth, y: cy + halfHeight },
      lThumb: { x: cx - halfWidth, y: cy + halfHeight },
      handSize: 70,
    },
    gap: (halfWidth * 2) / 70,
  };
}

interface Panel {
  kind: TransitionKind;
  ctx: CanvasRenderingContext2D;
  transition: PortalTransition;
  dimension: number;
  fired: boolean;
  layer: HTMLCanvasElement;
  mask: HTMLCanvasElement;
}

const root = document.querySelector<HTMLElement>('#demo')!;
root.innerHTML = `
  <header>
    <h1>Portal switch transitions</h1>
    <p>
      Every panel gets the identical synthetic hand motion — a close→open cycle
      on a loop — and fires its switch at the same instant. Watch how much of each
      transition is still visible once the hands are moving underneath it.
      The dashed outline is where the fingertips actually are; the filled shape is
      what gets drawn.
    </p>
  </header>
  <div class="controls" id="controls"></div>
  <div class="panels" id="panels"></div>
`;

const panelsEl = root.querySelector<HTMLElement>('#panels')!;
const panels: Panel[] = TRANSITION_KINDS.map((kind) => {
  const figure = document.createElement('figure');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const caption = document.createElement('figcaption');
  caption.innerHTML = `<strong>${kind}</strong><span>${TRANSITION_BLURBS[kind]}</span>`;
  figure.append(canvas, caption);
  panelsEl.append(figure);

  const off = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  return {
    kind,
    ctx: canvas.getContext('2d')!,
    transition: new PortalTransition(),
    dimension: 0,
    fired: false,
    layer: off(),
    mask: off(),
  };
});

// --- controls ---------------------------------------------------------------

const controls = root.querySelector<HTMLElement>('#controls')!;
type Key = 'collapseMs' | 'holdMs' | 'reopenMs' | 'overshoot' | 'twistDegrees';
const SLIDERS: { key: Key; label: string; min: number; max: number; step: number }[] = [
  { key: 'collapseMs', label: 'collapse', min: 0, max: 600, step: 10 },
  { key: 'holdMs', label: 'hold', min: 0, max: 600, step: 10 },
  { key: 'reopenMs', label: 'reopen', min: 0, max: 900, step: 10 },
  { key: 'overshoot', label: 'overshoot', min: 0, max: 3, step: 0.1 },
  { key: 'twistDegrees', label: 'twist°', min: 0, max: 360, step: 15 },
];

for (const s of SLIDERS) {
  const wrap = document.createElement('label');
  const out = document.createElement('span');
  out.textContent = String(spec[s.key]);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(s.min);
  input.max = String(s.max);
  input.step = String(s.step);
  input.value = String(spec[s.key]);
  input.oninput = () => {
    spec[s.key] = Number(input.value);
    out.textContent = input.value;
  };
  wrap.append(document.createTextNode(s.label), input, out);
  controls.append(wrap);
}

const speedWrap = document.createElement('label');
let speed = 1;
const speedOut = document.createElement('span');
speedOut.textContent = '1.0×';
const speedInput = document.createElement('input');
speedInput.type = 'range';
speedInput.min = '0.15';
speedInput.max = '1.5';
speedInput.step = '0.05';
speedInput.value = '1';
speedInput.oninput = () => {
  speed = Number(speedInput.value);
  speedOut.textContent = `${speed.toFixed(2)}×`;
};
speedWrap.append(document.createTextNode('hand speed'), speedInput, speedOut);
controls.append(speedWrap);

// --- render loop ------------------------------------------------------------

function pathOf(pts: Pt[]): Path2D {
  const p = new Path2D();
  p.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
  p.closePath();
  return p;
}

function drawPanel(panel: Panel, t: number, live: PortalPoints): void {
  const state = panel.transition.update(t, { ...spec, kind: panel.kind });
  if (state.swap) panel.dimension = (panel.dimension + 1) % DIMENSIONS.length;

  const shaped = applyTransition(live, state, panel.kind);
  const ctx = panel.ctx;

  // Stand-in for the camera feed.
  ctx.fillStyle = '#14161d';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 20) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, x);
    ctx.lineTo(W, x);
    ctx.stroke();
  }

  // Same layer + mask + destination-in path as src/renderer.ts.
  const lctx = panel.layer.getContext('2d')!;
  lctx.globalCompositeOperation = 'source-over';
  lctx.clearRect(0, 0, W, H);
  lctx.fillStyle = DIMENSIONS[panel.dimension].color;
  lctx.fillRect(0, 0, W, H);

  const mctx = panel.mask.getContext('2d')!;
  mctx.clearRect(0, 0, W, H);
  mctx.save();
  mctx.filter = 'blur(4px)';
  mctx.fillStyle = '#fff';
  mctx.fill(pathOf(polygonOrder(shaped)), 'evenodd');
  mctx.restore();

  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(panel.mask, 0, 0);
  ctx.drawImage(panel.layer, 0, 0);

  // Where the fingers actually are, for comparison against what is drawn.
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.stroke(pathOf(polygonOrder(live)));
  ctx.setLineDash([]);

  if (state.phase !== 'idle') {
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.fillText(`${state.phase} ${state.closure.toFixed(2)}`, 8, H - 8);
  }
}

let start = 0;
let simulated = 0;
let last = 0;

function frame(now: number): void {
  if (!start) {
    start = now;
    last = now;
  }
  // Scaling simulated time lets the hand motion slow down while the transition
  // keeps its real millisecond durations — which is the comparison that matters.
  simulated += (now - last) * speed;
  last = now;

  const phase = (simulated % CYCLE_MS) / CYCLE_MS;
  const { portal } = syntheticPortal(phase);

  // Fire every panel at the same instant: the moment the hands are shut.
  const shutNow = phase > 0.5 && phase < 0.52;
  for (const panel of panels) {
    if (shutNow && !panel.fired) {
      panel.fired = true;
      panel.transition.trigger(now);
    }
    if (!shutNow) panel.fired = false;
    drawPanel(panel, now, portal);
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
