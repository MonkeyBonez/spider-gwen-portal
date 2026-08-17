import { CONTACT_MODES, DEFAULT_WORST_SIDE_BIAS, type ContactMode } from './geometry';
import { LUCY_CODECS, type LucyCodec } from './lucyCodec';
import {
  TRANSITION_KINDS,
  TRANSITION_TIMINGS,
  type TransitionKind,
  type TransitionTiming,
} from './portalTransition';

/**
 * Tunable configuration for the portal POC.
 * Everything here is live-editable from the debug panel (§5) and persisted to
 * localStorage so tuning survives a reload.
 */

export interface Config {
  // --- capture / canvas -----------------------------------------------------
  /** Canonical canvas size. Lucy outputs 720p (PRD §7) so we lock to 1280x720. */
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  /** Mirror the displayed output (selfie view). Geometry is mirror-invariant. */
  mirror: boolean;

  // --- hand tracking --------------------------------------------------------
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
  /** Exponential moving average on the 4 portal points. 1 = no smoothing. */
  emaAlpha: number;
  /** Swap the left/right handedness assignment (mirror-mode ambiguity, §2.1). */
  swapHandedness: boolean;

  // --- gesture trigger ------------------------------------------------------
  /** Which cross-hand contacts count as closing the portal (§2.2.1). */
  contactMode: ContactMode;
  /**
   * How the portal's two sides combine into one `gap` (§2.2.1).
   * 0 = average them (one wide side cancels out one tight side); 1 = the wider
   * side alone decides. Symmetric poses read the same at every value, so this
   * can be changed without retuning the thresholds below.
   */
  worstSideBias: number;
  /** Normalised gap below which the portal counts as "touching"/closed. */
  closeThreshold: number;
  /** Normalised gap above which the portal counts as re-opened (hysteresis). */
  openThreshold: number;
  /**
   * Normalised gap at which the *reopen animation* starts, once a close has
   * fired (§4.1, `gestural` timing only). Decoupled from `closeThreshold` so the
   * portal can stay collapsed past the point where a close stops counting — the
   * hands get a head start and the portal catches up.
   *
   * Effectively `max(closeThreshold, releaseThreshold)`: a value below the close
   * threshold would mean blooming while still counted as shut, so it is clamped
   * up at the point of use rather than being allowed to invert.
   *
   * Setting it *above* `openThreshold` has no further effect — the fast-open
   * catch fires the release at `openThreshold` so it can never be lost behind
   * the re-arm. So the useful range is `[closeThreshold, openThreshold]`.
   */
  releaseThreshold: number;
  /** Frames the close condition must hold before CLOSED latches. */
  debounceFrames: number;
  /** Minimum ms between two dimension switches. */
  cooldownMs: number;
  /** |d(gap)/dt| required to count as "moving together"/"moving apart". 0 disables. */
  velocityEpsilon: number;
  /** How long a total tracking dropout is tolerated before the state machine resets. */
  lostResetMs: number;

  // --- compositing ----------------------------------------------------------
  /** Portal edge feather in px. */
  feather: number;

  // --- switch transition (§4.1) --------------------------------------------
  /** Which collapse/reopen animation plays on a dimension switch. */
  transitionKind: TransitionKind;
  /** Whether the two halves run on a clock or follow the hands (§4.1). */
  transitionTiming: TransitionTiming;
  collapseMs: number;
  /**
   * `timed` only — how long the portal stays shut. The dimension swaps at the
   * bottom of the collapse either way; Phase 1 fires setPrompt there.
   * `gestural` ignores this and holds until the hands part.
   */
  holdMs: number;
  /**
   * `gestural` only — last-resort escape hatch: reopen after this long no matter
   * what. **Default 0 (off).** The real protection against a portal stuck shut is
   * tracking loss, which the app handles directly — a timer here would also fire
   * while the hands are perfectly visible and deliberately held closed, which is
   * a performance, not a fault.
   */
  maxHoldMs: number;
  reopenMs: number;
  /** Back-easing strength on the reopen. 0 = plain ease-out. */
  reopenOvershoot: number;
  /** Peak rotation for the `twist` variant, degrees. */
  twistDegrees: number;

  // --- sync (Phase 1 placeholder, §2.3) ------------------------------------
  /** Delay applied to the raw feed + mask to align with Lucy's stream. */
  syncDelayMs: number;

  // --- Lucy session (Phase 1, §3) ------------------------------------------
  /**
   * Codec we ask the SDK to publish with. **Takes effect on the next connect**
   * (press `C` twice), not live.
   *
   * This is a latency knob, not a quality one. The SDK sets
   * `simulcast: codec !== 'vp9'`, so **`h264` publishes three simulcast layers**
   * — and the 2026-08-16 log shows Chrome then encoding all three in *software*
   * (`SimulcastEncoderAdapter (OpenH264 ×3)`) instead of using the Mac's
   * hardware encoder. Selecting `vp9` is the only way through the SDK's API to
   * get a single layer. Worth A/B-ing against the h264 baseline; vp9 software
   * encode has its own cost, so this is a measurement, not an obvious win.
   *
   * There is exactly one subscriber (the inference server), so simulcast is
   * paying for adaptation nobody uses. Worth raising with Decart.
   */
  lucyCodec: LucyCodec;

  // --- switch reveal (§4.1) -------------------------------------------------
  /**
   * Cover the model's restyle with the new dimension's colour, then cross-fade
   * to the live stream.
   *
   * Why this exists: `setPrompt` takes ~2.2s to become visible (ack 1.5–1.9s
   * plus a ~730ms pipeline, measured 2026-08-16), while a close→open cycle
   * takes well under a second. Collapsing the portal cannot mask a change that
   * lands four times later than the gesture that asked for it, so the portal
   * used to reopen onto the *old* dimension and morph into the new one in full
   * view. Opening onto a colour that resolves reads as intentional instead.
   */
  revealFromColor: boolean;
  /**
   * How long to hold the flat colour after the prompt is sent, before the
   * cross-fade begins. **Timed from the request, not from the portal opening**,
   * which is the important part: holding your hands closed longer spends this
   * budget, so a long enough hold reveals the settled stream with no fade at
   * all — the gesture masks the change exactly as originally intended, just at
   * a duration the performer controls.
   */
  revealHoldMs: number;
  /**
   * Cross-fade length. Generous on purpose: a slow fade also hides the *tail*
   * of the model settling, so it buys forgiveness for `revealHoldMs` being a
   * little short. 0 makes it a hard cut.
   */
  revealFadeMs: number;
  /**
   * Disconnect Lucy after this long with no hands detected. The stream bills
   * per generation-second, so an unattended session is money burning — but a
   * reconnect costs a 4–5s cold start (§2.3.1), so this trades one against the
   * other rather than being as aggressive as it could be. 0 disables it.
   */
  idleDisconnectMs: number;

  // --- debug ----------------------------------------------------------------
  showLandmarks: boolean;
  showPolygonOutline: boolean;
  showPanel: boolean;
}

export const DEFAULT_CONFIG: Config = {
  captureWidth: 1280,
  captureHeight: 720,
  captureFps: 30,
  mirror: true,

  minHandDetectionConfidence: 0.6,
  minHandPresenceConfidence: 0.6,
  minTrackingConfidence: 0.6,
  emaAlpha: 0.5,
  swapHandedness: false,

  // `all` measures the whole four-point cloud, so it reads far larger than the
  // side-pair modes for the same pose — these thresholds are on its scale, not
  // `paired`'s, and are provisional until tuned at /tune.html.
  contactMode: 'all',
  worstSideBias: DEFAULT_WORST_SIDE_BIAS,
  closeThreshold: 0.5,
  openThreshold: 0.9,
  releaseThreshold: 0.6,
  debounceFrames: 3,
  cooldownMs: 500,
  velocityEpsilon: 0.4,
  lostResetMs: 1000,

  feather: 6,

  // Settled (Sne): iris, driven gesturally. The other kinds and the timed path
  // stay selectable as controls, but these are the product defaults.
  transitionKind: 'iris',
  transitionTiming: 'gestural',
  collapseMs: 110,
  holdMs: 90,
  maxHoldMs: 0,
  reopenMs: 240,
  reopenOvershoot: 1.1,
  twistDegrees: 90,

  syncDelayMs: 0,

  idleDisconnectMs: 60_000,
  lucyCodec: 'h264',

  // Hold + fade = 2.5s, matching the measured 2.2–2.6s request→visible window.
  // Provisional: the `prompt:settle` curves in the session log are what should
  // set these, once there are a few runs' worth.
  revealFromColor: true,
  revealHoldMs: 1600,
  revealFadeMs: 900,

  showLandmarks: false,
  showPolygonOutline: true,
  showPanel: true,
};

// Bumped from v1: `all` contact mode is on a different scale, so a persisted v1
// close/open threshold would be badly wrong rather than merely stale.
const STORAGE_KEY = 'portal.config.v2';

/** The old `maxHoldMs` default, superseded. See the migration in `loadConfig`. */
const LEGACY_MAX_HOLD_MS = 2000;

export function loadConfig(): Config {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(cfg, JSON.parse(raw) as Partial<Config>);
  } catch {
    /* corrupt or unavailable storage — fall back to defaults */
  }
  // Stored values can name a variant that has since been cut, which would leave
  // the app rendering nothing. Fall back rather than trusting localStorage.
  if (!TRANSITION_KINDS.includes(cfg.transitionKind)) {
    cfg.transitionKind = DEFAULT_CONFIG.transitionKind;
  }
  if (!CONTACT_MODES.includes(cfg.contactMode)) {
    cfg.contactMode = DEFAULT_CONFIG.contactMode;
  }
  if (!TRANSITION_TIMINGS.includes(cfg.transitionTiming)) {
    cfg.transitionTiming = DEFAULT_CONFIG.transitionTiming;
  }
  if (!LUCY_CODECS.includes(cfg.lucyCodec)) {
    cfg.lucyCodec = DEFAULT_CONFIG.lucyCodec;
  }
  // Migration: `maxHoldMs` used to default to 2000, which reopened the portal on
  // a timer even while the hands were visibly still shut. Nobody ever chose that
  // number — it was only ever the default — so treat a stored 2000 as unset.
  // Done here rather than by bumping the storage key, which would also discard
  // hard-won threshold tuning.
  if (cfg.maxHoldMs === LEGACY_MAX_HOLD_MS) cfg.maxHoldMs = DEFAULT_CONFIG.maxHoldMs;
  // A bias outside [0,1] would extrapolate past the max and make `gap` nonsense.
  if (!Number.isFinite(cfg.worstSideBias)) cfg.worstSideBias = DEFAULT_CONFIG.worstSideBias;
  cfg.worstSideBias = Math.min(1, Math.max(0, cfg.worstSideBias));
  return cfg;
}

export function saveConfig(cfg: Config): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* non-fatal */
  }
}

export function resetConfig(cfg: Config): void {
  Object.assign(cfg, DEFAULT_CONFIG);
  saveConfig(cfg);
}
