/**
 * The getting-started choreography, as a reusable piece.
 *
 * ## What it is
 *
 * Three beats that teach the gesture, separated because people get its two
 * halves wrong in different ways — the *shape* (an L per hand, framing a window)
 * and the *motion* (pinch, touch, open again):
 *
 * 1. **Shape, close in.** The feed is dimmed except two hand-shaped holes.
 *    Nothing to read — you match your hands to the holes.
 * 2. **Shape, spread out.** The same holes, further apart. The portal is open by
 *    now and follows your hands, so pulling them apart *does* something.
 * 3. **Motion.** Two pinching hands meet over the portal. Copy them and it jumps.
 *
 * Between 1 and 2 the tracked skeleton draws itself over your hands for a beat —
 * a receipt that the machine can see you — and then retreats the way it came.
 *
 * ## Why it lives here and not in the page that shows it
 *
 * It runs in two places that must not drift: `/tutorial.html`, where it can be
 * refined against a flat colour for free, and the app, where the same beats
 * cover Lucy's 4–5s cold start so the wait is spent learning instead of
 * watching a spinner. Two copies of a choreography is two choreographies.
 *
 * The split is state and pixels here, hosting there. This module owns the phase
 * machine and every mark it makes on the overlay canvas; it does not own the
 * camera, the tracker, the portal geometry, the close trigger, or the caption
 * element. It is told what happened and reports what should be true.
 */

import type { Config } from './config';
import { dist, type HandPoints, type Pt } from './geometry';
import type { TrackedHands } from './handTracking';
import { HAND_CONNECTIONS, PORTAL_GREEN } from './overlay';
import { PALM_LOOP, outlinePair, type OutlinePair, type PoseOutline } from './tutorialPose';

export type TutorialPhase = 'place' | 'skeleton' | 'stretch' | 'jump' | 'done';

/**
 * `done` is deliberately empty. The last thing the tutorial teaches is the jump,
 * and the jump announces itself — the portal lands somewhere new, which needs no
 * caption agreeing with it. So the tutorial stops talking and removes its own
 * furniture, leaving the portal running.
 */
export const TUTORIAL_CAPTIONS: Record<TutorialPhase, string> = {
  place: 'Put your hands here to open your portal',
  skeleton: 'Got you',
  stretch: 'Now move into the new outlines to stretch your portal',
  jump: 'Touch your fingers together to jump to the next dimension',
  done: '',
};

/** How long both hands must hold the pose before a step completes. */
const DWELL_MS = 400;
/**
 * ...and longer for step 2, before handing over to the pinch.
 *
 * Step 1 hands over to a beat that fills the time itself — the skeleton draws
 * on. Step 2 hands over to a change of instruction, and at step 1's dwell that
 * arrived almost the instant the hands landed, so "stretch your portal" and
 * "touch your fingers together" trod on each other. The extra hold is not dead
 * air: both rims are locked green throughout, so it reads as the pose being
 * confirmed before the next thing is asked for.
 */
const STRETCH_DWELL_MS = 850;
/**
 * The skeleton flourish, in four beats.
 *
 * Milliseconds rather than fractions of a total because the two *pauses* are the
 * point and fractions kept swallowing them: the hold has to be long enough that
 * "the machine can see you" lands before the skeleton starts leaving, and the
 * settle has to leave a beat of empty frame so the next step does not cut in on
 * the tail of the retreat.
 */
const SKELETON_DRAW_IN_MS = 550;
/** Held complete. The beat where the reveal registers. */
const SKELETON_HOLD_MS = 600;
/** Slower than the draw-on: leaving should feel like a release, not a snap. */
const SKELETON_DRAW_OUT_MS = 700;
/** Gone, and nothing yet. Stops the next step treading on the exit. */
const SKELETON_SETTLE_MS = 180;
const SKELETON_MS =
  SKELETON_DRAW_IN_MS + SKELETON_HOLD_MS + SKELETON_DRAW_OUT_MS + SKELETON_SETTLE_MS;
/** How long the dimming takes to ease back in when step 2 puts targets up. */
const VEIL_FADE_MS = 320;
/** Portal bloom once the skeleton has drawn itself on. */
const POP_MS = 260;
/** Overshoot on the bloom — the portal snaps past full size and settles. */
const POP_OVERSHOOT = 1.15;
/** Silhouette thickness, in hand sizes. Tuned so fingers read as fingers. */
const LIMB_WIDTH = 0.34;

/** Guide geometry, as fractions of the frame. */
export interface GuideGeometry {
  /** Half the horizontal gap between the hands, step 1. */
  nearWidth: number;
  /** ...and step 2. */
  farWidth: number;
  /** Half the vertical span from index tip to thumb tip. Sets the hand size. */
  height: number;
  /** How dark the un-cut area gets. */
  veil: number;
  /** How close a fingertip must land to the guide's, in outline hand-sizes. */
  lock: number;
}

/**
 * Defaults, tuned on camera at 1280×720.
 *
 * `height` is the one that decides how big the *hands* are, which is not
 * obvious: the outline is fitted through its two fingertips, so the pose scales
 * with the span between them and there is no separate size dial. That coupling
 * is anatomy — one hand's index-to-thumb reach is a fixed multiple of its own
 * palm (~1.89 here) — so a portal that tall implies a hand that big. Matching a
 * real palm is the target: at 1280×720 an adult's wrist-to-middle-knuckle runs
 * ~180–220px, and 0.24 puts the guide at 183px.
 */
export const DEFAULT_GUIDE: GuideGeometry = {
  nearWidth: 0.07,
  farWidth: 0.21,
  height: 0.24,
  veil: 0.78,
  lock: 0.6,
};

// --- step 3's artwork ------------------------------------------------------

/** One close-and-open cycle. Slow enough to follow, quick enough to loop. */
const PINCH_LOOP_MS = 2600;
/** Artwork only: the source's teal footer is cropped off below this row. */
const PINCH_SRC = { x: 58, y: 0, w: 396, h: 482 };
/** Where the pinch sits within the cropped art. The hands are anchored on it. */
const PINCH_ANCHOR = { x: 0.497, y: 0.459 };
/** Closest approach, in hand widths. Below this the two hands tangle. */
const MIN_SEPARATION = 0.52;
/**
 * How far the hands part again, in hand widths beyond contact.
 *
 * Small on purpose. They used to swing right off the sides of the frame, which
 * turned a gesture into a journey — most of the loop spent travelling, and the
 * part that matters, the fingertips meeting, a brief event at one end.
 */
const PINCH_TRAVEL = 0.4;
/**
 * Art height per unit of `guide.height`.
 *
 * Needs its own factor because the drawing carries a forearm the landmark poses
 * do not, and that forearm has no clean end to crop at — the silhouette tapers
 * the whole way down, so cutting it anywhere leaves a blunt stump. The art is
 * kept whole and scaled so the *hand* lands at roughly life size, which puts the
 * forearms off the bottom of the frame where real ones would be anyway.
 */
const PINCH_ART_SCALE = 1.9;

const pinchIcon = new Image();
pinchIcon.src = `${import.meta.env.BASE_URL}pinch-hand.png`;

/** What the host should do with the portal this frame. */
export interface TutorialState {
  phase: TutorialPhase;
  caption: string;
  /** The portal exists from the skeleton's draw-in onward, not before. */
  portalOpen: boolean;
  /** 0..1 bloom, to floor the host's own transition closure with. */
  bloom: number;
  /** Whether a close→open should be acted on at all yet. */
  armed: boolean;
  complete: boolean;
  /** True for the one frame the tutorial's own jump landed. */
  justCompleted: boolean;
}

export interface TutorialInput {
  t: number;
  /** Canvas pixels — the space the guides and the tracker both live in. */
  width: number;
  height: number;
  hands: TrackedHands;
  handsPresent: boolean;
  /** True on the frame the portal finished shutting. */
  swapped: boolean;
}

export class TutorialFlow {
  /** Live-editable by `/tutorial.html`; the app leaves it at the defaults. */
  guide: GuideGeometry = { ...DEFAULT_GUIDE };

  private phaseValue: TutorialPhase = 'place';
  private phaseAt = 0;
  /** When both hands first satisfied the current step, or -1. */
  private dwellSince = -1;
  /** Set when the portal bloom starts, so the bloom can be driven. */
  private popAt = -1;
  private leftLocked = false;
  private rightLocked = false;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  get phase(): TutorialPhase {
    return this.phaseValue;
  }

  get complete(): boolean {
    return this.phaseValue === 'done';
  }

  /** Only step 3 and beyond should let a close→open do anything. */
  get armed(): boolean {
    return this.phaseValue === 'jump' || this.phaseValue === 'done';
  }

  reset(t: number): void {
    this.popAt = -1;
    this.setPhase('place', t);
  }

  private setPhase(next: TutorialPhase, t: number): void {
    this.phaseValue = next;
    this.phaseAt = t;
    this.dwellSince = -1;
    // Locks survive the skeleton beat on purpose. Both hands were locked a frame
    // ago — that is what ended step 1 — and nothing re-evaluates them until the
    // next step with guides to fill, so clearing them here would drop the rims
    // back to "not seen" white at the exact moment the page says "got you".
    if (next === 'place' || next === 'stretch') {
      this.leftLocked = false;
      this.rightLocked = false;
    }
  }

  update(input: TutorialInput): TutorialState {
    const { t, hands, handsPresent, swapped } = input;
    const pair = this.guidesFor(this.phaseValue, input.width, input.height);

    if (pair && (this.phaseValue === 'place' || this.phaseValue === 'stretch')) {
      const mirror = this.cfg.mirror;
      this.leftLocked = this.fills(mirror ? hands.left : hands.right, pair.left, input.width);
      this.rightLocked = this.fills(mirror ? hands.right : hands.left, pair.right, input.width);
      if (this.leftLocked && this.rightLocked && handsPresent) {
        if (this.dwellSince < 0) this.dwellSince = t;
        const needed = this.phaseValue === 'place' ? DWELL_MS : STRETCH_DWELL_MS;
        if (t - this.dwellSince >= needed) {
          this.setPhase(this.phaseValue === 'place' ? 'skeleton' : 'jump', t);
        }
      } else {
        this.dwellSince = -1;
      }
    } else if (this.phaseValue === 'skeleton') {
      // The portal arrives the instant the skeleton finishes drawing *in*, not
      // when the whole beat ends. The skeleton is the receipt for being seen and
      // the portal is the reward for it, so they belong on the same beat.
      if (this.popAt < 0 && t - this.phaseAt >= SKELETON_DRAW_IN_MS) this.popAt = t;
      if (t - this.phaseAt >= SKELETON_MS) this.setPhase('stretch', t);
    }

    let justCompleted = false;
    if (swapped && this.phaseValue === 'jump') {
      this.setPhase('done', t);
      justCompleted = true;
    }

    const popped = this.popAt >= 0;
    return {
      phase: this.phaseValue,
      caption: TUTORIAL_CAPTIONS[this.phaseValue],
      portalOpen: popped,
      bloom: popped ? easeOutBack(Math.min(1, (t - this.popAt) / POP_MS), POP_OVERSHOOT) : 0,
      armed: this.armed,
      complete: this.complete,
      justCompleted,
    };
  }

  /**
   * Every mark the tutorial makes, onto a transparent overlay canvas.
   *
   * The caller clears; this only draws. That is what lets the portal outline be
   * layered on top afterwards by `drawOverlay`, which has the same contract —
   * the dimming has to go *under* the outline of the window it is dimming.
   */
  paint(ctx: CanvasRenderingContext2D, input: TutorialInput): void {
    const { t, width, height } = input;
    const pair = this.guidesFor(this.phaseValue, width, height);

    // The dimming outlives the outlines by design — it fades out on its own
    // during the skeleton beat, when there are no cutouts left to punch.
    const veil = this.veilFor(t);
    if (pair) {
      this.paintGuides(ctx, pair, veil);
    } else if (veil > 0.002) {
      ctx.fillStyle = `rgba(0,0,0,${veil})`;
      ctx.fillRect(0, 0, width, height);
    }

    if (this.phaseValue === 'skeleton') {
      this.paintSkeleton(ctx, input, skeletonProgress(t - this.phaseAt));
    }
    if (this.phaseValue === 'jump') this.paintCloseGuide(ctx, input);
  }

  // --- geometry ------------------------------------------------------------

  /** Mirror a capture-space point into screen space, exactly as Renderer does. */
  private toScreen(p: Pt, width: number): Pt {
    return this.cfg.mirror ? { x: width - p.x, y: p.y } : p;
  }

  /**
   * The outlines to draw, if any.
   *
   * Nothing during the skeleton beat: by then you have matched the step-1
   * targets, so leaving them up asks for a pose you are holding and clutters the
   * frame at the moment the skeleton is trying to show you your own hands.
   */
  private guidesFor(p: TutorialPhase, width: number, height: number): OutlinePair | null {
    if (p === 'place') return outlinePair(width, height, this.guide.nearWidth, this.guide.height);
    if (p === 'stretch') return outlinePair(width, height, this.guide.farWidth, this.guide.height);
    return null;
  }

  /**
   * How dark the frame is, right now.
   *
   * The dimming exists to make the cutouts read, so it follows the outlines
   * rather than the portal: full while there is a target to hit, fading out as
   * the skeleton draws on and the targets go, then eased back — lighter than
   * before, since the portal is open by now — when step 2 puts new targets up.
   */
  private veilFor(t: number): number {
    if (this.phaseValue === 'place') return this.guide.veil;
    if (this.phaseValue === 'skeleton') {
      return this.guide.veil * Math.max(0, 1 - (t - this.phaseAt) / SKELETON_DRAW_IN_MS);
    }
    if (this.phaseValue === 'stretch') {
      return this.guide.veil * 0.62 * Math.min(1, (t - this.phaseAt) / VEIL_FADE_MS);
    }
    return 0;
  }

  /**
   * Is this hand filling this outline?
   *
   * Both fingertips inside a generous radius — generous because the guide is a
   * request for a pose, not a calibration target, and a tutorial that refuses to
   * advance is worse than one that advances a little early.
   */
  private fills(hand: HandPoints | null, outline: PoseOutline, width: number): boolean {
    if (!hand) return false;
    const r = outline.handSize * this.guide.lock;
    return (
      dist(this.toScreen(hand.index, width), outline.indexTip) < r &&
      dist(this.toScreen(hand.thumb, width), outline.thumbTip) < r
    );
  }

  // --- painting ------------------------------------------------------------

  /**
   * Dim the frame, then cut the hands out of the dimming.
   *
   * The rim is not stroked — canvas will not stroke the outline of a union of
   * thick lines. The silhouette is painted twice instead: once slightly fat in
   * the rim colour, then punched out at true size with `destination-out`, which
   * leaves the difference behind as a ring and lets the feed through the middle.
   *
   * The rim colour is the per-hand answer to "have I got you yet": white while
   * the guide is an empty target, `PORTAL_GREEN` the moment that hand lands.
   * Green is the same green the portal outline uses, so the colour means one
   * thing everywhere — this is tracked — rather than being per-layer decoration.
   */
  private paintGuides(ctx: CanvasRenderingContext2D, pair: OutlinePair, veil: number): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${veil})`;
    ctx.fillRect(0, 0, w, h);

    const hands: [PoseOutline, boolean][] = [
      [pair.left, this.leftLocked],
      [pair.right, this.rightLocked],
    ];
    for (const [outline, locked] of hands) {
      ctx.fillStyle = locked ? PORTAL_GREEN : 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = ctx.fillStyle;
      tracePose(ctx, outline.points, outline.handSize * LIMB_WIDTH * 1.13);
    }

    ctx.globalCompositeOperation = 'destination-out';
    ctx.filter = 'blur(2.5px)';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    for (const [outline] of hands) {
      tracePose(ctx, outline.points, outline.handSize * LIMB_WIDTH);
    }
    ctx.restore();
  }

  /**
   * The skeleton, drawing itself on. Bones arrive in topology order, each easing
   * out from its parent joint, so it reads as the hand being assembled rather
   * than fading in.
   */
  private paintSkeleton(
    ctx: CanvasRenderingContext2D,
    input: TutorialInput,
    progress: number,
  ): void {
    const drawWindow = 0.55;
    const perBone = drawWindow / HAND_CONNECTIONS.length;
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    for (const hand of input.hands.rawHands) {
      const pts = hand.points.map((p) => this.toScreen(p, input.width));
      ctx.strokeStyle = hand.label === 'Left' ? 'rgba(90,170,255,0.95)' : 'rgba(255,140,90,0.95)';
      ctx.fillStyle = ctx.strokeStyle;

      ctx.beginPath();
      for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
        const [a, b] = HAND_CONNECTIONS[i];
        if (!pts[a] || !pts[b]) continue;
        const local = (progress - i * perBone) / 0.18;
        if (local <= 0) continue;
        const grow = Math.min(1, local);
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[a].x + (pts[b].x - pts[a].x) * grow, pts[a].y + (pts[b].y - pts[a].y) * grow);
      }
      ctx.stroke();

      for (let i = 0; i < pts.length; i++) {
        // A joint appears once the bone that reaches it has arrived.
        const bone = HAND_CONNECTIONS.findIndex(([, b]) => b === i);
        const at = bone < 0 ? 0 : (bone + 1) * perBone;
        if (progress < at) continue;
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Step 3's guide: two pinching hands parting and meeting again over the
   * portal — the motion that shuts it and reopens it.
   *
   * ## Why a pinch, and why two of them
   *
   * `contactMode` defaults to `'all'`, which counts the portal shut only once
   * *every* pair among the four tracked fingertips has converged, same-hand
   * pairs included (`geometry.ts`). Bringing two L-hands together flat leaves
   * the index pair a thumb-span from the thumb pair: a zero-area slit, which
   * `all` correctly calls open. The gesture that closes it is each hand pinching
   * its own index to its own thumb, and the two pinches meeting.
   *
   * ## In the frame, at hand scale — like every other guide
   *
   * This lived in a corner panel first, and that was the wrong call: everything
   * else the tutorial asks for is shown life-size in the video where your hands
   * actually are, so a diagram off to one side made step 3 the odd one out and
   * asked you to translate from a picture to your own body.
   *
   * Unlike the other guides this is drawn art rather than generated landmarks —
   * an illustration, not a target anything is measured against. In this drawing
   * the pinch sits *mid-hand* rather than at an edge, so the two copies cannot
   * be brought anchor-to-anchor: past `MIN_SEPARATION` the fists overlap into an
   * unreadable knot.
   */
  private paintCloseGuide(ctx: CanvasRenderingContext2D, input: TutorialInput): void {
    if (!pinchIcon.complete || pinchIcon.naturalWidth === 0) return;
    const { t, width, height } = input;

    const handH = height * this.guide.height * PINCH_ART_SCALE;
    const handW = handH * (PINCH_SRC.w / PINCH_SRC.h);
    // 0 at the extremes of the loop, 1 at closest approach.
    const closeness = 0.5 - 0.5 * Math.cos((2 * Math.PI * (t % PINCH_LOOP_MS)) / PINCH_LOOP_MS);
    const travel = handW * (MIN_SEPARATION + PINCH_TRAVEL * (1 - closeness));

    // They meet on the portal's centre — the thing they are closing.
    const cx = width / 2;
    const cy = height / 2;

    ctx.save();
    ctx.globalAlpha = 0.85;
    paintPinchHand(ctx, cx + travel, cy, handH, false);
    paintPinchHand(ctx, cx - travel, cy, handH, true);

    ctx.globalAlpha = Math.max(0, closeness * 1.6 - 0.6);
    ctx.fillStyle = PORTAL_GREEN;
    ctx.beginPath();
    ctx.arc(cx, cy, handH * 0.018, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// --- free functions --------------------------------------------------------

/** Matches `easeOutBack` in portalTransition.ts — the app's bloom curve. */
function easeOutBack(p: number, s: number): number {
  const c = 1 - p;
  return 1 + s * Math.pow(c, 3) - s * Math.pow(c, 2) - Math.pow(c, 3);
}

/**
 * Where the skeleton's draw-on has got to, from milliseconds into the beat: up,
 * held, back down, then nothing.
 *
 * Running the same progress backwards is an exact reverse of the arrival — bones
 * appear when progress passes their slot and vanish when it falls back through
 * it, so the last bone to arrive is the first to leave.
 */
function skeletonProgress(elapsed: number): number {
  if (elapsed < SKELETON_DRAW_IN_MS) return elapsed / SKELETON_DRAW_IN_MS;
  const leaving = elapsed - SKELETON_DRAW_IN_MS - SKELETON_HOLD_MS;
  if (leaving <= 0) return 1;
  return Math.max(0, 1 - leaving / SKELETON_DRAW_OUT_MS);
}

/** A hand silhouette: filled palm plus every bone stroked fat and round. */
function tracePose(ctx: CanvasRenderingContext2D, points: Pt[], width: number): void {
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  PALM_LOOP.forEach((i, n) =>
    n === 0 ? ctx.moveTo(points[i].x, points[i].y) : ctx.lineTo(points[i].x, points[i].y),
  );
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
 * One pinching hand, anchored on its pinch.
 *
 * The dark halo is a slightly dilated copy underneath. Over a live camera feed
 * it is what keeps white line art legible against whatever happens to be behind
 * it, and it lets the near hand read as *in front of* the far one where they
 * meet. The source art is black line work, so it is inverted to white.
 */
function paintPinchHand(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  handH: number,
  mirror: boolean,
): void {
  const handW = handH * (PINCH_SRC.w / PINCH_SRC.h);
  const dx = -PINCH_ANCHOR.x * handW;
  const dy = -PINCH_ANCHOR.y * handH;
  ctx.save();
  ctx.translate(cx, cy);
  if (mirror) ctx.scale(-1, 1);

  const r = handH * 0.012;
  ctx.filter = 'brightness(0) saturate(0)';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.drawImage(
      pinchIcon, PINCH_SRC.x, PINCH_SRC.y, PINCH_SRC.w, PINCH_SRC.h,
      dx + Math.cos(a) * r, dy + Math.sin(a) * r, handW, handH,
    );
  }
  ctx.filter = 'invert(1)';
  ctx.drawImage(
    pinchIcon, PINCH_SRC.x, PINCH_SRC.y, PINCH_SRC.w, PINCH_SRC.h, dx, dy, handW, handH,
  );
  ctx.filter = 'none';
  ctx.restore();
}
