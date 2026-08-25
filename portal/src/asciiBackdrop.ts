/**
 * The start screen's living backdrop.
 *
 * Two stacked canvases behind the copy: the webcam rendered as a field of
 * ASCII glyphs, and a constellation of drifting nodes that knits threads
 * between its neighbours — and leans toward whatever is bright on camera, so
 * the web gathers around you without ever being told where you are.
 *
 * It is the app's own thesis, running before anything has been pressed: the
 * machine is already watching the room and drawing what it finds. Nothing is
 * uploaded — the frames never leave this module, and the stream is released
 * the moment a session launches so the app can open the camera with its own
 * capture constraints rather than inheriting these.
 */

/** Brighter pixel → denser glyph. Leading space is the empty cell. */
const RAMP = ' .:-=+*#%@';

/** Character cell in CSS pixels. Also the resolution the camera is sampled at. */
const CELL_W = 9;
const CELL_H = 15;

/**
 * Auto-exposure. A dim room renders as a near-blank page — technically
 * faithful and visually nothing — so the frame's average luminance is pulled
 * toward a midtone. A well-lit room lands at gain 1 and passes through
 * untouched.
 */
const TARGET_LUM = 0.45;
const MAX_GAIN = 6;

/** Threads are drawn between nodes closer than this, fading with distance. */
const LINK = 130;
/** The cursor gets a longer reach than the nodes do — it is the spider. */
const MOUSE_LINK = 190;

/** How far apart the two luminance probes sit when a node reads the gradient. */
const PROBE = 26;

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export class AsciiBackdrop {
  private readonly host: HTMLElement;

  private readonly ascii = document.createElement('canvas');
  private readonly web = document.createElement('canvas');
  private readonly scrim = document.createElement('div');
  private readonly actx: CanvasRenderingContext2D;
  private readonly wctx: CanvasRenderingContext2D;

  /**
   * The video is drawn into this at one pixel per character cell, so the
   * downscale is the GPU's problem and the per-cell luminance is a single
   * cheap read rather than an average over a block.
   */
  private readonly sampler = document.createElement('canvas');
  private readonly sctx: CanvasRenderingContext2D;
  private readonly video = document.createElement('video');

  private stream: MediaStream | null = null;
  private raf = 0;
  private listeners: AbortController | null = null;
  private running = false;

  private w = 0;
  private h = 0;
  private cols = 0;
  private rows = 0;
  /** Gained luminance per cell. Read by the drawing pass and by the nodes. */
  private lum = new Float32Array(0);
  private nodes: Node[] = [];
  private readonly mouse = { x: -9999, y: -9999 };

  constructor(host: HTMLElement) {
    this.host = host;

    this.ascii.className = 'backdrop-layer';
    this.web.className = 'backdrop-layer';
    this.scrim.className = 'backdrop-scrim';

    this.actx = this.ascii.getContext('2d')!;
    this.wctx = this.web.getContext('2d')!;
    // The sampler is read every frame; without this hint Chrome keeps trying
    // to keep it on the GPU and pays a readback each time.
    this.sctx = this.sampler.getContext('2d', { willReadFrequently: true })!;

    this.video.muted = true;
    this.video.playsInline = true;

    host.prepend(this.ascii, this.web, this.scrim);
  }

  /**
   * Mounts the animation and asks for the camera. Safe to call again after
   * `stop()` — that is the path back from a finished session.
   *
   * Never rejects: a refused or busy camera simply leaves the constellation
   * drifting on its own, which is a perfectly good backdrop. The start screen
   * has real work to do and must not be blocked on a decoration.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.listeners = new AbortController();
    const { signal } = this.listeners;
    window.addEventListener('resize', () => this.resize(), { signal });
    window.addEventListener(
      'pointermove',
      (e) => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
      },
      { signal },
    );
    window.addEventListener(
      'pointerleave',
      () => {
        this.mouse.x = -9999;
        this.mouse.y = -9999;
      },
      { signal },
    );

    this.resize();
    this.raf = requestAnimationFrame(() => this.frame());

    void this.openCamera();
  }

  /**
   * Releases the camera and stops drawing.
   *
   * Called before a session launches. The app opens the camera itself with its
   * own width/height/frameRate, and a second live track on the same device is
   * both wasteful and a way to end up with constraints nobody asked for.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.listeners?.abort();
    this.listeners = null;

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  private async openCamera(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 640, height: 360 },
        audio: false,
      });
      // `stop()` may have already run while the permission prompt was up.
      if (!this.running) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
    } catch {
      // Denied, missing, or held by another tab. The constellation carries on
      // without a mirror; the launch buttons are unaffected either way.
    }
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));

    for (const c of [this.ascii, this.web]) {
      c.width = this.w;
      c.height = this.h;
    }

    this.cols = Math.ceil(this.w / CELL_W);
    this.rows = Math.ceil(this.h / CELL_H);
    this.sampler.width = this.cols;
    this.sampler.height = this.rows;
    this.lum = new Float32Array(this.cols * this.rows);

    // Density scales with area, so a laptop gets a web and a phone does not
    // get a solid mat of lines.
    const count = Math.min(110, Math.floor((this.w * this.h) / 16000));
    this.nodes = Array.from({ length: count }, () => ({
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      r: 1 + Math.random() * 1.6,
    }));
  }

  /** Gained luminance at a canvas point, from the most recent frame. */
  private lumAt(x: number, y: number): number {
    if (!this.lum.length) return 0;
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(x / CELL_W)));
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(y / CELL_H)));
    return this.lum[cy * this.cols + cx];
  }

  private frame(): void {
    if (!this.running) return;
    if (this.video.readyState >= 2) this.drawMirror();
    this.drawWeb();
    this.raf = requestAnimationFrame(() => this.frame());
  }

  private drawMirror(): void {
    const { video, cols, rows } = this;

    // Cover-crop to the canvas aspect, mirrored — it is a mirror, so a hand
    // raised on the right must appear on the right.
    const videoAspect = video.videoWidth / video.videoHeight;
    const canvasAspect = this.w / this.h;
    let sw = video.videoWidth;
    let sh = video.videoHeight;
    let sx = 0;
    let sy = 0;
    if (videoAspect > canvasAspect) {
      sw = sh * canvasAspect;
      sx = (video.videoWidth - sw) / 2;
    } else {
      sh = sw / canvasAspect;
      sy = (video.videoHeight - sh) / 2;
    }

    this.sctx.save();
    this.sctx.scale(-1, 1);
    this.sctx.drawImage(video, sx, sy, sw, sh, -cols, 0, cols, rows);
    this.sctx.restore();

    const px = this.sctx.getImageData(0, 0, cols, rows).data;

    let sum = 0;
    for (let c = 0, i = 0; c < this.lum.length; c++, i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      this.lum[c] = l;
      sum += l;
    }
    const gain = Math.min(
      MAX_GAIN,
      Math.max(1, TARGET_LUM / (sum / this.lum.length + 0.001)),
    );
    if (gain > 1) {
      for (let c = 0; c < this.lum.length; c++) {
        this.lum[c] = Math.min(1, this.lum[c] * gain);
      }
    }

    const ctx = this.actx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0b0f';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.font = `${CELL_H - 2}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'top';

    // The font's advance is narrower than CELL_W, so a row of `cols` glyphs
    // stops short of the right edge and leaves a dead band there. Scaling x by
    // the measured ratio lands exactly one glyph per cell, edge to edge.
    const advance = ctx.measureText('M').width || CELL_W;
    ctx.setTransform(CELL_W / advance, 0, 0, 1, 0, 0);

    // One fillText per row: a per-character call costs an order of magnitude
    // more, and at this cell size that is ~14k calls a frame.
    ctx.fillStyle = 'rgba(0, 255, 180, 0.26)';
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const l = this.lum[y * cols + x];
        line += RAMP[Math.min(RAMP.length - 1, Math.floor(l * RAMP.length))];
      }
      ctx.fillText(line, 0, y * CELL_H);
    }
  }

  private drawWeb(): void {
    const ctx = this.wctx;
    const { w, h, nodes, mouse } = this;
    ctx.clearRect(0, 0, w, h);

    for (const n of nodes) {
      // Climb toward the light: compare luminance a probe-step away on each
      // axis and accelerate up the gradient. With no camera the gradient is
      // flat and this reduces to the plain drift.
      const gx = this.lumAt(n.x + PROBE, n.y) - this.lumAt(n.x - PROBE, n.y);
      const gy = this.lumAt(n.x, n.y + PROBE) - this.lumAt(n.x, n.y - PROBE);
      n.vx += gx * 0.05;
      n.vy += gy * 0.05;
      // Damping, or the climb becomes a swarm piling into the brightest cell.
      n.vx *= 0.985;
      n.vy *= 0.985;
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
      n.x = Math.max(0, Math.min(w, n.x));
      n.y = Math.max(0, Math.min(h, n.y));
    }

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > LINK * LINK) continue;
        const t = 1 - Math.sqrt(d2) / LINK;
        ctx.strokeStyle = `rgba(0, 255, 180, ${0.16 * t})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      const mdx = a.x - mouse.x;
      const mdy = a.y - mouse.y;
      const md2 = mdx * mdx + mdy * mdy;
      if (md2 < MOUSE_LINK * MOUSE_LINK) {
        const t = 1 - Math.sqrt(md2) / MOUSE_LINK;
        ctx.strokeStyle = `rgba(0, 255, 180, ${0.4 * t})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
        // …and the web leans toward you, gently.
        a.vx -= mdx * 0.000012;
        a.vy -= mdy * 0.000012;
      }
    }

    ctx.fillStyle = 'rgba(231, 233, 238, 0.4)';
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
