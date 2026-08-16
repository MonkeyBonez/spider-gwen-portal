/**
 * Debug panel (PRD §5). Live thresholds, toggles, readouts, and a rolling plot
 * of the normalised gap against the close/open thresholds — the fastest way to
 * pick real numbers instead of the guesses in the PRD.
 */

import { resetConfig, saveConfig, type Config } from './config';
import { CONTACT_BLURBS, CONTACT_MODES } from './geometry';
import { TRANSITION_BLURBS, TRANSITION_KINDS } from './portalTransition';

type NumKeys = {
  [K in keyof Config]: Config[K] extends number ? K : never;
}[keyof Config];
type BoolKeys = {
  [K in keyof Config]: Config[K] extends boolean ? K : never;
}[keyof Config];
type StringKeys = {
  [K in keyof Config]: Config[K] extends string ? K : never;
}[keyof Config];

interface SliderSpec {
  key: NumKeys;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

const SLIDERS: SliderSpec[] = [
  { key: 'emaAlpha', label: 'EMA α', min: 0.05, max: 1, step: 0.05, hint: '1 = no smoothing' },
  {
    key: 'worstSideBias',
    label: 'Worst-side bias',
    min: 0,
    max: 1,
    step: 0.05,
    hint: '0 = average the sides · 1 = the wider side decides',
  },
  { key: 'closeThreshold', label: 'Close threshold', min: 0, max: 2, step: 0.01 },
  { key: 'openThreshold', label: 'Open threshold', min: 0, max: 3, step: 0.01 },
  { key: 'debounceFrames', label: 'Debounce frames', min: 1, max: 15, step: 1 },
  { key: 'cooldownMs', label: 'Cooldown', min: 0, max: 2000, step: 50 },
  { key: 'velocityEpsilon', label: 'Velocity ε', min: 0, max: 4, step: 0.05, hint: '0 = ignore velocity' },
  { key: 'minHandPresenceConfidence', label: 'Presence conf.', min: 0.1, max: 0.95, step: 0.05 },
  { key: 'lostResetMs', label: 'Lost reset', min: 0, max: 3000, step: 100 },
  { key: 'feather', label: 'Feather px', min: 0, max: 40, step: 1 },
  { key: 'collapseMs', label: 'Collapse', min: 0, max: 600, step: 10 },
  { key: 'holdMs', label: 'Hold shut', min: 0, max: 600, step: 10, hint: 'where the swap lands' },
  { key: 'reopenMs', label: 'Reopen', min: 0, max: 900, step: 10 },
  { key: 'reopenOvershoot', label: 'Reopen overshoot', min: 0, max: 3, step: 0.1, hint: '0 = no pop' },
  { key: 'twistDegrees', label: 'Twist°', min: 0, max: 360, step: 15, hint: 'twist variant only' },
  { key: 'syncDelayMs', label: 'Sync Δ (Phase 1)', min: 0, max: 500, step: 10 },
];

const TOGGLES: { key: BoolKeys; label: string }[] = [
  { key: 'showLandmarks', label: 'Landmark overlay' },
  { key: 'showPolygonOutline', label: 'Polygon outline' },
  { key: 'mirror', label: 'Mirror view' },
  { key: 'swapHandedness', label: 'Swap L/R hands' },
];

export interface Readouts {
  fps: number;
  detectMs: number;
  state: string;
  gap: number;
  area: number;
  gapVelocity: number;
  hands: string;
  dimension: string;
  switches: number;
  extra: Record<string, string | number>;
}

const HISTORY = 240;

export class DebugPanel {
  readonly el: HTMLElement;
  private cfg: Config;
  private readoutEls = new Map<string, HTMLElement>();
  private readoutBody: HTMLElement;
  private plot: HTMLCanvasElement;
  private plotCtx: CanvasRenderingContext2D;
  private gapHistory: number[] = [];
  private gapMin = Infinity;
  private gapMax = -Infinity;
  private onReset: () => void;

  constructor(cfg: Config, onReset: () => void) {
    this.cfg = cfg;
    this.onReset = onReset;
    this.el = document.createElement('aside');
    this.el.className = 'panel';

    const header = el('div', 'panel-header', '<strong>Debug</strong><span class="hint">D toggles</span>');
    this.el.append(header);

    this.readoutBody = el('div', 'readouts');
    this.el.append(this.readoutBody);

    this.plot = document.createElement('canvas');
    this.plot.width = 300;
    this.plot.height = 72;
    this.plot.className = 'plot';
    this.plotCtx = this.plot.getContext('2d')!;
    this.el.append(this.plot);
    this.el.append(el('div', 'hint plot-caption', 'gap over last ~8s · red = close · green = open'));

    this.el.append(
      this.select('contactMode', 'Contact mode', CONTACT_MODES, CONTACT_BLURBS),
      this.select('transitionKind', 'Switch transition', TRANSITION_KINDS, TRANSITION_BLURBS),
    );

    for (const spec of SLIDERS) this.el.append(this.slider(spec));
    for (const t of TOGGLES) this.el.append(this.toggle(t.key, t.label));

    const buttons = el('div', 'buttons');
    const resetCounters = button('Reset counters', () => {
      this.gapMin = Infinity;
      this.gapMax = -Infinity;
      this.onReset();
    });
    const resetCfg = button('Reset settings', () => {
      resetConfig(this.cfg);
      this.syncInputs();
    });
    buttons.append(resetCounters, resetCfg);
    this.el.append(buttons);
  }

  private inputs: { sync: () => void }[] = [];

  /** Generic <select> bound to a string-valued config key. */
  private select<K extends StringKeys>(
    key: K,
    label: string,
    options: readonly Config[K][],
    blurbs?: Record<string, string>,
  ): HTMLElement {
    const row = el('div', 'row');
    row.append(el('label', '', label));
    const input = document.createElement('select');
    for (const v of options) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = String(v);
      input.append(o);
    }
    input.value = String(this.cfg[key]);
    const blurb = blurbs ? el('div', 'hint', blurbs[String(this.cfg[key])] ?? '') : null;
    input.onchange = () => {
      (this.cfg[key] as string) = input.value;
      if (blurb) blurb.textContent = blurbs?.[input.value] ?? '';
      saveConfig(this.cfg);
    };
    row.append(input);
    if (blurb) row.append(blurb);
    this.inputs.push({
      sync: () => {
        input.value = String(this.cfg[key]);
        if (blurb) blurb.textContent = blurbs?.[input.value] ?? '';
      },
    });
    return row;
  }

  private slider(spec: SliderSpec): HTMLElement {
    const row = el('div', 'row slider');
    const label = el('label', '', `${spec.label}`);
    const value = el('span', 'value', fmt(this.cfg[spec.key]));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(this.cfg[spec.key]);
    input.oninput = () => {
      (this.cfg[spec.key] as number) = Number(input.value);
      value.textContent = fmt(this.cfg[spec.key]);
      saveConfig(this.cfg);
    };
    const head = el('div', 'row-head');
    head.append(label, value);
    row.append(head, input);
    if (spec.hint) row.append(el('div', 'hint', spec.hint));
    this.inputs.push({
      sync: () => {
        input.value = String(this.cfg[spec.key]);
        value.textContent = fmt(this.cfg[spec.key]);
      },
    });
    return row;
  }

  private toggle(key: BoolKeys, label: string): HTMLElement {
    const row = el('label', 'row toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.cfg[key];
    input.onchange = () => {
      (this.cfg[key] as boolean) = input.checked;
      saveConfig(this.cfg);
    };
    row.append(input, document.createTextNode(label));
    this.inputs.push({ sync: () => (input.checked = this.cfg[key]) });
    return row;
  }

  /** Re-read every control from the config (after a keyboard change or reset). */
  syncInputs(): void {
    for (const i of this.inputs) i.sync();
  }

  update(r: Readouts): void {
    if (Number.isFinite(r.gap) && r.gap > 0) {
      this.gapMin = Math.min(this.gapMin, r.gap);
      this.gapMax = Math.max(this.gapMax, r.gap);
    }
    this.gapHistory.push(r.gap);
    if (this.gapHistory.length > HISTORY) this.gapHistory.shift();

    const rows: [string, string][] = [
      ['fps', r.fps.toFixed(0)],
      ['detect', `${r.detectMs.toFixed(1)} ms`],
      ['state', r.state],
      ['gap', r.gap.toFixed(3)],
      ['gap min/max', `${finite(this.gapMin)} / ${finite(this.gapMax)}`],
      ['area', r.area.toFixed(2)],
      ['d(gap)/dt', r.gapVelocity.toFixed(2)],
      ['hands', r.hands],
      ['dimension', r.dimension],
      ['switches', String(r.switches)],
      ...Object.entries(r.extra).map(([k, v]) => [k, String(v)] as [string, string]),
    ];
    for (const [k, v] of rows) {
      let node = this.readoutEls.get(k);
      if (!node) {
        const row = el('div', 'readout');
        row.append(el('span', 'k', k));
        node = el('span', 'v', '');
        row.append(node);
        this.readoutBody.append(row);
        this.readoutEls.set(k, node);
      }
      if (node.textContent !== v) node.textContent = v;
    }

    this.drawPlot();
  }

  private drawPlot(): void {
    const { width: w, height: h } = this.plot;
    const ctx = this.plotCtx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, w, h);

    const top = Math.max(this.cfg.openThreshold * 1.6, 1.2);
    const y = (v: number) => h - Math.min(v / top, 1) * h;

    for (const [v, color] of [
      [this.cfg.closeThreshold, 'rgba(255,90,90,0.9)'],
      [this.cfg.openThreshold, 'rgba(90,255,150,0.9)'],
    ] as [number, string][]) {
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y(v));
      ctx.lineTo(w, y(v));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = 'rgba(120,200,255,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.gapHistory.forEach((v, i) => {
      const px = (i / (HISTORY - 1)) * w;
      if (i === 0) ctx.moveTo(px, y(v));
      else ctx.lineTo(px, y(v));
    });
    ctx.stroke();
  }
}

function el(tag: string, className = '', html = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function finite(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}
