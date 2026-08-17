/**
 * Live close-detection tuner (PRD §2.2.1) — real camera, real hands.
 *
 * `/closure.html` compares strictnesses on a pose you drag with a mouse. This
 * one compares them on the gesture you actually perform, which is the only way
 * to pick a number by feel.
 *
 * The mechanism: five *independent* copies of the real `CloseOpenTrigger` run in
 * parallel, one per worst-side bias, all fed the same frames. Each keeps its own
 * switch count. So you perform ten deliberate closes plus whatever sloppy
 * lopsided ones you're worried about, and read off which bias counted ten.
 *
 * Settings are the app's own (same localStorage key), so whatever you land on
 * here is what the app uses.
 */

import './style.css';
import './demo.css';
import './tuneDemo.css';
import { loadConfig, saveConfig, type Config } from './config';
import {
  CONTACT_BLURBS,
  CONTACT_MODES,
  blendSides,
  normalizedGap,
  polygonOrder,
  sideGaps,
  smoothPortal,
  type ContactMode,
  type PortalPoints,
} from './geometry';
import { HandTracker } from './handTracking';
import { CloseOpenTrigger } from './triggers/closeOpenTrigger';

/** The strictnesses raced against each other. Mirrors /closure.html. */
const BIASES = [0, 0.25, 0.5, 0.75, 1];
/** EMA on d(gap)/dt, matching app.ts. */
const VELOCITY_ALPHA = 0.35;
/** How many (sideA, sideB) samples the scatter remembers. ~8s at 30fps. */
const TRAIL = 240;
const MAP_MAX = 1.2;
const FIRE_FLASH_MS = 450;

const cfg: Config = loadConfig();

/** One racer: a real trigger, its own smoothed velocity, its own tally. */
interface Lane {
  bias: number;
  trigger: CloseOpenTrigger;
  prevGap: number;
  velocity: number;
  gap: number;
  state: string;
  switches: number;
  firedAt: number;
  el: HTMLElement;
  gapEl: HTMLElement;
  countEl: HTMLElement;
  stateEl: HTMLElement;
  appEl: HTMLElement;
}

interface Sample {
  a: number;
  b: number;
  fired: boolean;
}

const lanes: Lane[] = [];
const trail: Sample[] = [];

// --- DOM -------------------------------------------------------------------

const root = document.getElementById('demo')!;
root.innerHTML = `
  <header>
    <h1>Close detection — tune it on your own hands</h1>
    <p>
      Five copies of the real trigger run at once, one per <strong>worst-side bias</strong>,
      all watching the same hands. Each counts its own switches. Do ten deliberate
      close→open cycles, then deliberately do the sloppy thing — one side wide, the other
      pinched — and see which bias counted ten and which over-counted.
      Whatever you set here is what the app uses.
    </p>
  </header>

  <div class="gate" id="start">
    <button id="start-btn">Enable camera</button>
    <p class="error hidden" id="error"></p>
  </div>

  <div class="tuner hidden" id="tuner">
    <div class="controls">
      <label>bias <input type="range" id="bias" min="0" max="1" step="0.05" /><span id="bias-v"></span></label>
      <label>close threshold <input type="range" id="close" min="0.05" max="1.5" step="0.01" /><span id="close-v"></span></label>
      <label>release threshold <input type="range" id="release" min="0.05" max="2" step="0.01" /><span id="release-v"></span></label>
      <label>open threshold <input type="range" id="open" min="0.05" max="2" step="0.01" /><span id="open-v"></span></label>
      <label>contact mode <select id="mode"></select></label>
      <button id="reset">Reset counts</button>
    </div>

    <div class="main">
      <figure class="preview">
        <canvas id="cam" width="1280" height="720"></canvas>
        <figcaption id="cam-caption">—</figcaption>
      </figure>

      <div class="lanes" id="lanes"></div>
    </div>

    <section class="analysis">
      <figure>
        <canvas id="map" width="320" height="320"></canvas>
        <figcaption>
          <strong>your hands, in side-vs-side space</strong>
          <span>
            Side A across, side B up, in hand-widths. The shaded corner is what the
            <em>current</em> bias and close threshold call shut. Dots are the last few
            seconds of your actual hands; bright dots are frames where a switch fired.
            Tune so the shaded corner covers the closes you meant and misses the ones
            you didn't.
          </span>
        </figcaption>
      </figure>

      <div class="explain">
        <h3>What the two numbers mean</h3>
        <dl>
          <dt>close threshold</dt>
          <dd>
            <strong>How near counts as touching.</strong> Yes — it's the distance your
            hands must get <em>under</em>. Measured in hand-widths, not pixels, so it
            works the same near or far from the camera: <code>0.35</code> means the sides
            must close to about a third of a hand's width. Lower = you must close more
            tightly.
          </dd>
          <dt>release threshold</dt>
          <dd>
            <strong>Where the portal starts blooming open again.</strong> Only used by the
            <code>gestural</code> timing. Set it above the close threshold and the portal
            stays collapsed after your hands have technically stopped counting as shut —
            they get a head start and the portal catches up. Set it equal to the close
            threshold and the bloom begins the instant you leave the closed band. It is
            clamped up to the close threshold, since blooming while still counted as shut
            makes no sense.
          </dd>
          <dt>open threshold</dt>
          <dd>
            The distance you must get back <em>over</em> before another switch can fire.
            It sits above the close threshold on purpose, so a hand trembling right at
            the line can't fire twice. <em>This does not drive the animation</em> — by the
            time you reach it the bloom is already underway.
          </dd>
          <dt>worst-side bias</dt>
          <dd>
            <strong>Not a distance — it decides which distance gets measured</strong> when
            your two sides disagree. At <code>0</code> the two sides are averaged, so a
            wide side is cancelled out by a tight one. At <code>1</code> only the wider
            side counts, so both must be shut. In between, a wide side forces the other
            to be much tighter. When both sides match, every setting reads the same —
            which is why changing this doesn't make you re-tune the thresholds.
          </dd>
        </dl>
      </div>
    </section>
  </div>
`;

const startEl = root.querySelector<HTMLElement>('#start')!;
const startBtn = root.querySelector<HTMLButtonElement>('#start-btn')!;
const errorEl = root.querySelector<HTMLElement>('#error')!;
const tunerEl = root.querySelector<HTMLElement>('#tuner')!;
const lanesEl = root.querySelector<HTMLElement>('#lanes')!;
const camCanvas = root.querySelector<HTMLCanvasElement>('#cam')!;
const camCaption = root.querySelector<HTMLElement>('#cam-caption')!;
const mapCanvas = root.querySelector<HTMLCanvasElement>('#map')!;
const biasEl = root.querySelector<HTMLInputElement>('#bias')!;
const biasV = root.querySelector<HTMLElement>('#bias-v')!;
const closeEl = root.querySelector<HTMLInputElement>('#close')!;
const closeV = root.querySelector<HTMLElement>('#close-v')!;
const openEl = root.querySelector<HTMLInputElement>('#open')!;
const openV = root.querySelector<HTMLElement>('#open-v')!;
const releaseEl = root.querySelector<HTMLInputElement>('#release')!;
const releaseV = root.querySelector<HTMLElement>('#release-v')!;
const modeEl = root.querySelector<HTMLSelectElement>('#mode')!;

for (const m of CONTACT_MODES) {
  const o = document.createElement('option');
  o.value = m;
  o.textContent = m;
  modeEl.append(o);
}

for (const bias of BIASES) {
  const el = document.createElement('div');
  el.className = 'lane';
  const head = document.createElement('div');
  head.className = 'lane-head';
  const label = document.createElement('strong');
  label.textContent = `bias ${bias.toFixed(2)}`;
  const countEl = document.createElement('span');
  countEl.className = 'count';
  head.append(label, countEl);
  const stateEl = document.createElement('span');
  stateEl.className = 'lane-state';
  const gapEl = document.createElement('span');
  gapEl.className = 'lane-gap';
  const appEl = document.createElement('span');
  appEl.className = 'lane-app';
  el.append(head, stateEl, gapEl, appEl);
  lanesEl.append(el);

  lanes.push({
    bias,
    trigger: new CloseOpenTrigger(),
    prevGap: 0,
    velocity: 0,
    gap: 0,
    state: 'IDLE',
    switches: 0,
    firedAt: -Infinity,
    el,
    gapEl,
    countEl,
    stateEl,
    appEl,
  });
}

function syncControls(): void {
  biasEl.value = String(cfg.worstSideBias);
  biasV.textContent = cfg.worstSideBias.toFixed(2);
  closeEl.value = String(cfg.closeThreshold);
  closeV.textContent = cfg.closeThreshold.toFixed(2);
  openEl.value = String(cfg.openThreshold);
  openV.textContent = cfg.openThreshold.toFixed(2);
  releaseEl.value = String(cfg.releaseThreshold);
  // Show the effective value when it has been clamped up by the close threshold.
  const effective = Math.max(cfg.closeThreshold, cfg.releaseThreshold);
  releaseV.textContent =
    effective > cfg.releaseThreshold
      ? `${cfg.releaseThreshold.toFixed(2)} → ${effective.toFixed(2)}`
      : cfg.releaseThreshold.toFixed(2);
  modeEl.value = cfg.contactMode;

  // Mark the rung the app's setting is closest to. The slider is continuous and
  // the ladder is not, so "nearest" rather than "equal" — otherwise a value like
  // 0.70 sits between rungs and nothing highlights at all.
  const nearest = nearestLane();
  for (const lane of lanes) {
    const isNearest = lane === nearest;
    lane.el.classList.toggle('active', isNearest);
    lane.appEl.textContent =
      isNearest && Math.abs(lane.bias - cfg.worstSideBias) > 1e-6
        ? `app: ${cfg.worstSideBias.toFixed(2)}`
        : isNearest
          ? 'app setting'
          : '';
  }
}

function nearestLane(): Lane {
  return lanes.reduce((best, lane) =>
    Math.abs(lane.bias - cfg.worstSideBias) < Math.abs(best.bias - cfg.worstSideBias) ? lane : best,
  );
}

biasEl.oninput = () => {
  cfg.worstSideBias = Number(biasEl.value);
  saveConfig(cfg);
  syncControls();
};
closeEl.oninput = () => {
  cfg.closeThreshold = Number(closeEl.value);
  saveConfig(cfg);
  syncControls();
};
openEl.oninput = () => {
  cfg.openThreshold = Number(openEl.value);
  saveConfig(cfg);
  syncControls();
};
releaseEl.oninput = () => {
  cfg.releaseThreshold = Number(releaseEl.value);
  saveConfig(cfg);
  syncControls();
};
modeEl.onchange = () => {
  cfg.contactMode = modeEl.value as ContactMode;
  saveConfig(cfg);
  syncControls();
};
root.querySelector<HTMLButtonElement>('#reset')!.onclick = () => {
  for (const lane of lanes) {
    lane.switches = 0;
    lane.trigger.reset();
  }
  trail.length = 0;
};

syncControls();

// --- camera + loop ---------------------------------------------------------

const tracker = new HandTracker();
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;

let smoothed: PortalPoints | null = null;
let lastFrameAt = 0;
let fps = 0;
let lastPortalAt = -Infinity;

startBtn.onclick = async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
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
    camCanvas.width = video.videoWidth;
    camCanvas.height = video.videoHeight;

    startBtn.textContent = 'Loading hand model…';
    await tracker.init(cfg);

    startEl.classList.add('hidden');
    tunerEl.classList.remove('hidden');
    lastFrameAt = performance.now();
    requestAnimationFrame(loop);
  } catch (err) {
    startBtn.disabled = false;
    startBtn.textContent = 'Enable camera';
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.classList.remove('hidden');
    console.error(err);
  }
};

if (!navigator.mediaDevices?.getUserMedia) {
  errorEl.textContent = 'This browser has no camera API. Use Chrome/Safari over localhost or https.';
  errorEl.classList.remove('hidden');
  startBtn.disabled = true;
}

function loop(t: number): void {
  const dt = Math.min((t - lastFrameAt) / 1000, 0.25);
  lastFrameAt = t;
  if (dt > 0) fps += (1 / dt - fps) * 0.1;

  const hands = tracker.detect(video, t, cfg);
  if (hands.portal) {
    smoothed = smoothPortal(smoothed, hands.portal, cfg.emaAlpha);
    lastPortalAt = t;
  } else if (t - lastPortalAt > cfg.lostResetMs) {
    smoothed = null;
  }

  const handsPresent = hands.portal !== null;
  const current = nearestLane();
  let anyFired = false;

  for (const lane of lanes) {
    const gap = smoothed ? normalizedGap(smoothed, cfg.contactMode, lane.bias) : lane.prevGap;
    if (handsPresent && dt > 0) {
      const instant = (gap - lane.prevGap) / dt;
      lane.velocity += (instant - lane.velocity) * VELOCITY_ALPHA;
    } else {
      lane.velocity = 0;
    }
    lane.prevGap = gap;
    lane.gap = gap;

    const result = lane.trigger.update(
      { t, dt, handsPresent, gap, area: gap * gap, gapVelocity: lane.velocity },
      cfg,
    );
    lane.state = result.state;
    if (result.advance) {
      lane.switches++;
      lane.firedAt = t;
      if (lane === current) anyFired = true;
    }
  }

  if (smoothed) {
    const s = sideGaps(smoothed, cfg.contactMode, cfg.worstSideBias);
    trail.push({ a: s.a, b: s.b, fired: anyFired });
    if (trail.length > TRAIL) trail.shift();
  }

  drawCamera(hands.rawHands);
  drawLanes(t);
  drawMap();
  updateCaption(handsPresent);

  requestAnimationFrame(loop);
}

// --- drawing ---------------------------------------------------------------

function drawCamera(rawHands: { points: { x: number; y: number }[] }[]): void {
  const ctx = camCanvas.getContext('2d')!;
  const { width: w, height: h } = camCanvas;

  ctx.save();
  if (cfg.mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);

  // Fingertips, so it is obvious when tracking drops.
  ctx.fillStyle = 'rgba(0,255,180,0.5)';
  for (const hand of rawHands) {
    for (const p of hand.points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (smoothed) {
    const gap = normalizedGap(smoothed, cfg.contactMode, cfg.worstSideBias);
    const closed = gap < cfg.closeThreshold;
    const pts = polygonOrder(smoothed);
    const path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    path.closePath();

    ctx.fillStyle = closed ? 'rgba(255,90,90,0.35)' : 'rgba(120,200,255,0.28)';
    ctx.fill(path, 'evenodd');
    ctx.strokeStyle = closed ? 'rgba(255,120,120,0.95)' : 'rgba(120,200,255,0.95)';
    ctx.lineWidth = 3;
    ctx.stroke(path);

    // The two sides being measured, drawn thick — the whole question made visible.
    const s = sideGaps(smoothed, cfg.contactMode, cfg.worstSideBias);
    const wide = s.a >= s.b;
    ctx.lineWidth = 6;
    ctx.strokeStyle = wide ? 'rgba(255,200,80,0.95)' : 'rgba(160,160,180,0.7)';
    line(ctx, smoothed.lIndex, smoothed.rIndex);
    ctx.strokeStyle = wide ? 'rgba(160,160,180,0.7)' : 'rgba(255,200,80,0.95)';
    line(ctx, smoothed.lThumb, smoothed.rThumb);
  }
  ctx.restore();
}

function line(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawLanes(t: number): void {
  for (const lane of lanes) {
    const closed = lane.gap < cfg.closeThreshold;
    lane.el.classList.toggle('closed', closed);
    lane.el.classList.toggle('fired', t - lane.firedAt < FIRE_FLASH_MS);
    lane.countEl.textContent = `${lane.switches}`;
    lane.stateEl.textContent = lane.state;
    lane.gapEl.textContent = `gap ${lane.gap.toFixed(3)}`;
  }
}

function drawMap(): void {
  const ctx = mapCanvas.getContext('2d')!;
  const { width: w, height: h } = mapCanvas;
  const N = 48;
  const cell = w / N;
  const toPx = (v: number) => (v / MAP_MAX) * w;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = ((i + 0.5) / N) * MAP_MAX;
      const b = ((j + 0.5) / N) * MAP_MAX;
      if (blendSides(a, b, cfg.worstSideBias) >= cfg.closeThreshold) continue;
      ctx.fillStyle = 'rgba(255,90,90,0.35)';
      ctx.fillRect(i * cell, h - (j + 1) * cell, cell + 0.5, cell + 0.5);
    }
  }

  // Where your hands actually went.
  trail.forEach((s, i) => {
    const age = i / Math.max(1, trail.length - 1);
    const x = Math.min(w - 2, toPx(s.a));
    const y = Math.max(2, h - toPx(s.b));
    ctx.fillStyle = s.fired
      ? 'rgba(255,255,255,0.95)'
      : `rgba(120,200,255,${0.10 + age * 0.55})`;
    ctx.beginPath();
    ctx.arc(x, y, s.fired ? 3.5 : 1.8, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('side A →', w - 60, h - 6);
  ctx.save();
  ctx.translate(11, 60);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('side B →', 0, 0);
  ctx.restore();
}

function updateCaption(handsPresent: boolean): void {
  if (!smoothed) {
    camCaption.textContent = `no hands · ${fps.toFixed(0)} fps`;
    return;
  }
  const s = sideGaps(smoothed, cfg.contactMode, cfg.worstSideBias);
  const gap = normalizedGap(smoothed, cfg.contactMode, cfg.worstSideBias);
  const mean = (s.a + s.b) / 2;
  const max = Math.max(s.a, s.b);
  camCaption.textContent =
    `sides ${s.a.toFixed(2)} / ${s.b.toFixed(2)} · mean ${mean.toFixed(2)} · max ${max.toFixed(2)}` +
    ` · gap ${gap.toFixed(3)} ${gap < cfg.closeThreshold ? 'CLOSED' : 'open'}` +
    ` · ${handsPresent ? '' : 'tracking lost · '}${fps.toFixed(0)} fps`;
}

root.querySelector<HTMLElement>('#mode')!.title = CONTACT_BLURBS[cfg.contactMode];
