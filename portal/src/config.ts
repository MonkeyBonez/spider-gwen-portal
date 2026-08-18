import { CONTACT_MODES, DEFAULT_WORST_SIDE_BIAS, type ContactMode } from './geometry';
import { LUCY_CODECS, type LucyCodec } from './lucyCodec';
import { SYNC_MODES, type SyncMode } from './syncMode';
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

  // --- sync (§2.3 V2) -------------------------------------------------------
  /**
   * Where the compensation delay comes from.
   *
   * `auto` tracks the SDK's measured glass-to-glass figure continuously rather
   * than sampling it once at startup. That matters: Δ was observed climbing
   * from 588ms to a 635ms plateau over the first ~30 seconds of a session
   * (2026-08-17), so a single early reading would calibrate ~50ms short and
   * then drift further out as the session warmed up.
   */
  syncMode: SyncMode;
  /**
   * Delay applied to the raw feed + mask to align with Lucy's stream.
   *
   * Under `manual` this is the value used. Under `auto` it is overwritten with
   * whatever is currently being applied, so the slider always shows the truth
   * and switching to `manual` freezes the current value rather than jumping.
   */
  syncDelayMs: number;
  /**
   * How fast the applied delay may change, ms per second.
   *
   * Changing it moves which buffered frame is shown, so an instant jump would
   * skip or repeat frames visibly. Ramping means the preview runs fractionally
   * slow while it converges — at 150ms/s that is a 15% time compression for a
   * few seconds, which is far less noticeable than a jump, and it only happens
   * at startup and on genuine drift.
   */
  syncSlewMsPerSec: number;
  /**
   * Keep the portal on its dimension colour until the pipeline is calibrated —
   * Δ measured and the compensation delay converged — then fade the stream in.
   *
   * Without this the first few seconds are the worst the effect ever looks: the
   * stream appears immediately, but Δ is not measurable for ~2s (the SDK
   * excludes the start of a stream from its own average) and the delay is still
   * ramping, so the seam slides visibly before settling. Waiting costs a few
   * seconds of coloured portal and buys a correct first impression.
   *
   * In the product this wait is free: §4.3's tutorial takes far longer than the
   * pipeline needs, so the calibration hides entirely inside teaching the
   * gesture (Sne's idea).
   */
  warmUpBeforeReveal: boolean;

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
   *
   * **Measured 2026-08-16, so `vp9` is now the default:** encode cost fell from
   * 7.1ms to 2.0ms per frame and Δ from 630ms to 601ms, with outbound frame
   * rate unchanged at 30. Note the SDK forces vp8 on desktop Safari regardless.
   */
  lucyCodec: LucyCodec;

  // --- switch reveal (§4.1) -------------------------------------------------
  /**
   * Cover the model's restyle with the new dimension's colour, then cross-fade
   * to the live stream.
   *
   * Why this exists: a prompt becomes visible **400–900ms** after it is sent
   * (measured 2026-08-16), which is the same order as a close→open cycle — so
   * a quick cycle reopens onto the *old* dimension and cuts to the new one in
   * full view. Opening onto a colour that resolves reads as intentional.
   *
   * Worth knowing what the curves showed: the change arrives as a **step, not
   * a morph** — one 100ms sample apart, the frame difference jumps to its
   * plateau and stays. So there is nothing gradual to hide, only a cut to
   * cover, which is why a short fade is enough.
   */
  revealFromColor: boolean;
  /**
   * **Fallback only.** The reveal normally starts the instant the restyle is
   * detected on screen (see `settleProbe.ts`), which is what keeps dead colour
   * down to a single 50ms sampling period. This timer is the ceiling for the
   * cases detection cannot cover — a cold start with no frames to compare, or a
   * restyle too subtle to spike — so it should rarely be what fires.
   *
   * Counted from the request, so holding your hands closed spends the same
   * budget: a long enough hold reveals with no fade at all.
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
  /**
   * Record the camera and Lucy streams to `portal/logs/*.webm` for offline
   * analysis (dev server only — there is nowhere to write them otherwise).
   *
   * Both are recorded **raw and separately**, never the composite: the whole
   * point is to be able to measure the offset between them, which compositing
   * destroys. Roughly 1–2MB per second per stream, so it is a debugging tool,
   * not something to leave on.
   */
  recordStreams: boolean;

  /**
   * Migration marker. Bump it and add a case in `loadConfig` when a *default*
   * changes in a way that a stored setting would silently override.
   *
   * This exists because that has now happened twice — a persisted `maxHoldMs`
   * reopened the portal on a timer, and a persisted `lucyCodec` kept two runs
   * on h264 after vp9 was measured better, costing ~120ms each time without
   * anything on screen saying so. Storing tuned values is the point of the
   * config; the hazard is that it also stores values nobody chose.
   */
  schemaVersion: number;

  // --- debug ----------------------------------------------------------------
  showLandmarks: boolean;
  showPolygonOutline: boolean;
  showPanel: boolean;
}

/**
 * Current config schema. See `Config.schemaVersion`.
 *
 * 2 → 3: move to the vp9 publish codec. Measured better on 2026-08-16 (encode
 * 7.1ms → 2.0ms, Δ 630ms → 601ms at the same frame rate), but two later runs
 * still went out on h264 because the stored value won. Sne asked for the
 * measured default to be applied, so this moves it once. Setting h264 by hand
 * afterwards sticks — the migration is keyed on the version, not the value.
 */
const SCHEMA_VERSION = 3;

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

  syncMode: 'auto',
  syncDelayMs: 0,
  syncSlewMsPerSec: 150,
  warmUpBeforeReveal: true,

  idleDisconnectMs: 60_000,
  recordStreams: true,
  lucyCodec: 'vp9',

  // Hold + fade = 1.0s, from the `prompt:settle` curves on 2026-08-16: five
  // switches landed between 400ms and 900ms after the request. Biased to
  // over-cover slightly — trailing colour reads as intentional, whereas
  // under-covering shows the old dimension and then a hard cut.
  revealFromColor: true,
  revealHoldMs: 600,
  revealFadeMs: 400,

  schemaVersion: SCHEMA_VERSION,

  showLandmarks: false,
  showPolygonOutline: true,
  showPanel: true,
};

// Bumped from v1: `all` contact mode is on a different scale, so a persisted v1
// close/open threshold would be badly wrong rather than merely stale.
const STORAGE_KEY = 'portal.config.v2';


/** The old `maxHoldMs` default, superseded. See the migration in `loadConfig`. */
const LEGACY_MAX_HOLD_MS = 2000;

/**
 * The first reveal defaults, set from a bad estimate of how long a prompt takes
 * to land (2.5s; it is nearer 0.6s). Migrated for the same reason as
 * `maxHoldMs`: nobody chose these, and leaving them persisted would mean a
 * second of dead colour after every switch.
 */
const LEGACY_REVEAL_HOLD_MS = 1600;
const LEGACY_REVEAL_FADE_MS = 900;

export function loadConfig(): Config {
  const cfg = { ...DEFAULT_CONFIG };
  // Read the *stored* version before merging. Taking it from `cfg` afterwards
  // would read the default that was just merged in, so an old config would
  // always look current and no migration would ever run — which a test caught.
  let storedVersion = 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Config>;
      storedVersion = typeof stored.schemaVersion === 'number' ? stored.schemaVersion : 2;
      Object.assign(cfg, stored);
    }
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
  if (!SYNC_MODES.includes(cfg.syncMode)) {
    cfg.syncMode = DEFAULT_CONFIG.syncMode;
  }
  // Migration: `maxHoldMs` used to default to 2000, which reopened the portal on
  // a timer even while the hands were visibly still shut. Nobody ever chose that
  // number — it was only ever the default — so treat a stored 2000 as unset.
  // Done here rather than by bumping the storage key, which would also discard
  // hard-won threshold tuning.
  if (cfg.maxHoldMs === LEGACY_MAX_HOLD_MS) cfg.maxHoldMs = DEFAULT_CONFIG.maxHoldMs;
  // Version-keyed migrations: each runs once, then the marker moves past it.
  // `storedVersion` is 0 when there was nothing stored, in which case the
  // defaults are already current and the migration is a no-op anyway.
  if (storedVersion > 0 && storedVersion < 3) cfg.lucyCodec = 'vp9';
  cfg.schemaVersion = SCHEMA_VERSION;
  if (cfg.revealHoldMs === LEGACY_REVEAL_HOLD_MS && cfg.revealFadeMs === LEGACY_REVEAL_FADE_MS) {
    cfg.revealHoldMs = DEFAULT_CONFIG.revealHoldMs;
    cfg.revealFadeMs = DEFAULT_CONFIG.revealFadeMs;
  }
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
