/**
 * Close-detection comparison (PRD §2.2.1), driven by the real `geometry` module
 * so the demo cannot drift from what ships.
 *
 * The question it exists to answer: how strict should the portal's *worse* side
 * be? Averaging the two sides lets a wide one be cancelled out by a tight one, so
 * a plainly open triangle latches CLOSED. Every panel below shows the same pose
 * at a different `worstSideBias`, so the only thing that varies between them is
 * the strictness.
 */

import './style.css';
import './demo.css';
import './closureDemo.css';
import {
  CONTACT_BLURBS,
  CONTACT_MODES,
  blendSides,
  normalizedGap,
  polygonOrder,
  sideGaps,
  type ContactMode,
  type PortalPoints,
  type Pt,
} from './geometry';

const W = 240;
const H = 240;
/** The strictnesses shown side by side. Mirrored by `BIASES` in the tests. */
const BIASES = [0, 0.25, 0.5, 0.75, 1];
const HAND_SIZE = 100;
const HIT_RADIUS = 16;

const LABELS = ['L-idx', 'R-idx', 'R-thm', 'L-thm'] as const;

/** Poses in polygon order: L-index, R-index, R-thumb, L-thumb. */
const PRESETS: { name: string; note: string; pts: Pt[] }[] = [
  {
    name: 'wide index · thumbs shut',
    note: 'The reported bug. Sides 0.60 / 0.01 average to 0.30 — under the threshold.',
    pts: [
      { x: 60, y: 60 },
      { x: 120, y: 60 },
      { x: 90.5, y: 160 },
      { x: 90, y: 160 },
    ],
  },
  {
    name: 'symmetric shut',
    note: 'A real close. Must read CLOSED at every bias.',
    pts: [
      { x: 118, y: 118 },
      { x: 122, y: 118 },
      { x: 122, y: 122 },
      { x: 118, y: 122 },
    ],
  },
  {
    name: 'symmetric open',
    note: 'A real open. Reads identically at every bias — that is the invariant.',
    pts: [
      { x: 55, y: 55 },
      { x: 185, y: 55 },
      { x: 185, y: 185 },
      { x: 55, y: 185 },
    ],
  },
  {
    name: 'closing, still level',
    note: 'Mid-close with both sides equal. Bias should not change the verdict.',
    pts: [
      { x: 105, y: 100 },
      { x: 135, y: 100 },
      { x: 135, y: 140 },
      { x: 105, y: 140 },
    ],
  },
  {
    name: 'thumb-pivot hinge',
    note: 'Thumbs pressed together, index fingers swung wide. Open at every bias.',
    pts: [
      { x: 30, y: 40 },
      { x: 210, y: 40 },
      { x: 121, y: 190 },
      { x: 120, y: 190 },
    ],
  },
  {
    name: 'crossed shut (rotated hand)',
    note: 'Shut, but index meets the opposite thumb. `paired` sees it, `strict` does not.',
    pts: [
      { x: 99, y: 170 },
      { x: 100, y: 80 },
      { x: 101, y: 170 },
      { x: 100, y: 79 },
    ],
  },
];

const state = {
  pts: PRESETS[0].pts.map((p) => ({ ...p })),
  bias: 0.7,
  closeThreshold: 0.35,
  mode: 'paired' as ContactMode,
};

function portalOf(pts: Pt[]): PortalPoints {
  return {
    lIndex: pts[0],
    rIndex: pts[1],
    rThumb: pts[2],
    lThumb: pts[3],
    handSize: HAND_SIZE,
  };
}

// --- DOM -------------------------------------------------------------------

const root = document.getElementById('demo')!;
root.innerHTML = `
  <header>
    <h1>Close detection — how strict is the worse side?</h1>
    <p>
      <code>gap</code> collapses the portal's two sides into one number. Averaging them
      lets a wide side be cancelled out by a tight one, so a visibly open portal reads as
      shut. <strong>Worst-side bias</strong> interpolates between that average (0) and
      letting the wider side alone decide (1). Every panel is the <em>same pose</em> at a
      different bias — drag the points in any one and they all follow. Symmetric poses
      read identically at every bias, so this can be tuned without touching the
      thresholds.
    </p>
  </header>

  <div class="controls">
    <label>bias <input type="range" id="bias" min="0" max="1" step="0.01" /><span id="bias-v"></span></label>
    <label>close threshold <input type="range" id="thr" min="0.05" max="1" step="0.01" /><span id="thr-v"></span></label>
    <label>contact mode <select id="mode"></select></label>
    <span class="mode-blurb" id="mode-blurb"></span>
  </div>

  <div class="presets" id="presets"></div>

  <div class="panels" id="panels"></div>

  <section class="analysis">
    <figure>
      <canvas id="map" width="300" height="300"></canvas>
      <figcaption>
        <strong>which side pairs read as CLOSED</strong>
        <span>
          Side A across, side B up, both in hand-widths. Shaded = closed at the
          current bias and threshold; the outline is bias 0 for comparison; the cross is
          the live pose. Drag the bias slider: the region contracts from a triangle
          (either side can carry the other) to a square (both must be shut).
        </span>
      </figcaption>
    </figure>
    <div class="readouts" id="readouts"></div>
  </section>
`;

const biasEl = root.querySelector<HTMLInputElement>('#bias')!;
const biasV = root.querySelector<HTMLElement>('#bias-v')!;
const thrEl = root.querySelector<HTMLInputElement>('#thr')!;
const thrV = root.querySelector<HTMLElement>('#thr-v')!;
const modeEl = root.querySelector<HTMLSelectElement>('#mode')!;
const modeBlurb = root.querySelector<HTMLElement>('#mode-blurb')!;
const panelsEl = root.querySelector<HTMLElement>('#panels')!;
const presetsEl = root.querySelector<HTMLElement>('#presets')!;
const readoutsEl = root.querySelector<HTMLElement>('#readouts')!;
const mapCanvas = root.querySelector<HTMLCanvasElement>('#map')!;

for (const m of CONTACT_MODES) {
  const o = document.createElement('option');
  o.value = m;
  o.textContent = m;
  modeEl.append(o);
}

for (const preset of PRESETS) {
  const b = document.createElement('button');
  b.textContent = preset.name;
  b.title = preset.note;
  b.onclick = () => {
    state.pts = preset.pts.map((p) => ({ ...p }));
    render();
  };
  presetsEl.append(b);
}

interface Panel {
  bias: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  figure: HTMLElement;
  verdict: HTMLElement;
  detail: HTMLElement;
}

const panels: Panel[] = BIASES.map((bias) => {
  const figure = document.createElement('figure');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const caption = document.createElement('figcaption');
  const verdict = document.createElement('strong');
  const detail = document.createElement('span');
  caption.append(verdict, detail);
  figure.append(canvas, caption);
  panelsEl.append(figure);
  attachDrag(canvas);
  return { bias, canvas, ctx: canvas.getContext('2d')!, figure, verdict, detail };
});

// --- drawing ---------------------------------------------------------------

function pathOf(pts: Pt[]): Path2D {
  const p = new Path2D();
  p.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
  p.closePath();
  return p;
}

function drawPanel(panel: Panel): void {
  const { ctx } = panel;
  const portal = portalOf(state.pts);
  const gap = normalizedGap(portal, state.mode, panel.bias);
  const closed = gap < state.closeThreshold;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = closed ? 'rgba(255,90,90,0.10)' : 'rgba(255,255,255,0.02)';
  ctx.fillRect(0, 0, W, H);

  // Even-odd over the real traversal order, matching renderer.ts — a rotated
  // hand makes a bowtie here exactly as it does in the app.
  const path = pathOf(polygonOrder(portal));
  ctx.fillStyle = closed ? 'rgba(255,90,90,0.28)' : 'rgba(120,200,255,0.22)';
  ctx.fill(path, 'evenodd');
  ctx.strokeStyle = closed ? 'rgba(255,120,120,0.95)' : 'rgba(120,200,255,0.95)';
  ctx.lineWidth = 1.5;
  ctx.stroke(path);

  ctx.font = '600 10px ui-monospace, monospace';
  state.pts.forEach((p, i) => {
    ctx.fillStyle = 'rgba(0,255,180,0.95)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(LABELS[i], p.x + 8, p.y - 8);
  });

  panel.figure.classList.toggle('closed', closed);
  panel.verdict.textContent = `bias ${panel.bias.toFixed(2)} · ${closed ? 'CLOSED' : 'open'}`;
  panel.detail.textContent = `gap ${gap.toFixed(3)}`;
}

/**
 * Decision boundary. For every (sideA, sideB) in hand-widths, does the blend fall
 * under the close threshold? Drawn per-cell rather than per-pixel — the boundary
 * is a straight line, so a coarse grid is exact enough and stays cheap on drag.
 */
function drawMap(): void {
  const ctx = mapCanvas.getContext('2d')!;
  const { width: w, height: h } = mapCanvas;
  const MAX = 1.2;
  const N = 60;
  const cell = w / N;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, w, h);

  const toPx = (v: number) => (v / MAX) * w;
  const sideAt = (i: number) => ((i + 0.5) / N) * MAX;

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = sideAt(i);
      const b = sideAt(j);
      if (blendSides(a, b, state.bias) >= state.closeThreshold) continue;
      ctx.fillStyle = 'rgba(255,90,90,0.45)';
      ctx.fillRect(i * cell, h - (j + 1) * cell, cell + 0.5, cell + 0.5);
    }
  }

  // Bias-0 boundary (a + b = 2 * threshold) for reference.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, h - toPx(2 * state.closeThreshold));
  ctx.lineTo(toPx(2 * state.closeThreshold), h);
  ctx.stroke();
  ctx.setLineDash([]);

  // The live pose. Clamped inside the frame so a touching pair (side ≈ 0) still
  // draws a whole cross instead of half of one on the edge.
  const s = sideGaps(portalOf(state.pts), state.mode, state.bias);
  const inside = (v: number, extent: number) => Math.min(extent - 8, Math.max(8, v));
  const cx = inside(toPx(Math.min(s.a, MAX)), w);
  const cy = inside(h - toPx(Math.min(s.b, MAX)), h);
  ctx.strokeStyle = 'rgba(0,255,180,0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy);
  ctx.lineTo(cx + 7, cy);
  ctx.moveTo(cx, cy - 7);
  ctx.lineTo(cx, cy + 7);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('side A →', w - 62, h - 6);
  ctx.save();
  ctx.translate(10, 62);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('side B →', 0, 0);
  ctx.restore();
}

function drawReadouts(): void {
  const portal = portalOf(state.pts);
  const s = sideGaps(portal, state.mode, state.bias);
  const mean = (s.a + s.b) / 2;
  const max = Math.max(s.a, s.b);
  const gap = normalizedGap(portal, state.mode, state.bias);

  const rows: [string, string][] = [
    ['side A', s.a.toFixed(3)],
    ['side B', s.b.toFixed(3)],
    ['mean (bias 0)', mean.toFixed(3)],
    ['max (bias 1)', max.toFixed(3)],
    [`gap @ bias ${state.bias.toFixed(2)}`, gap.toFixed(3)],
    ['verdict', gap < state.closeThreshold ? 'CLOSED' : 'open'],
    [
      'gap s/p/a',
      CONTACT_MODES.map((m) => normalizedGap(portal, m, state.bias).toFixed(2)).join(' / '),
    ],
  ];

  readoutsEl.innerHTML = rows
    .map(([k, v]) => `<div class="readout"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join('');
}

function render(): void {
  biasEl.value = String(state.bias);
  biasV.textContent = state.bias.toFixed(2);
  thrEl.value = String(state.closeThreshold);
  thrV.textContent = state.closeThreshold.toFixed(2);
  modeEl.value = state.mode;
  modeBlurb.textContent = CONTACT_BLURBS[state.mode];
  for (const p of panels) drawPanel(p);
  drawMap();
  drawReadouts();
}

// --- interaction -----------------------------------------------------------

/** Drag any panel; they all show the same pose, so all of them update. */
function attachDrag(canvas: HTMLCanvasElement): void {
  let held = -1;
  const at = (e: PointerEvent): Pt => {
    const r = canvas.getBoundingClientRect();
    // Canvases are CSS-scaled, so map back into the 240x240 drawing space.
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const p = at(e);
    held = state.pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < HIT_RADIUS);
    if (held >= 0) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (held < 0) return;
    state.pts[held] = at(e);
    render();
  });
  canvas.addEventListener('pointerup', () => {
    held = -1;
  });
}

biasEl.oninput = () => {
  state.bias = Number(biasEl.value);
  render();
};
thrEl.oninput = () => {
  state.closeThreshold = Number(thrEl.value);
  render();
};
modeEl.onchange = () => {
  state.mode = modeEl.value as ContactMode;
  render();
};

render();
