import { CONTACT_MODES, type ContactMode } from './geometry';
import { TRANSITION_KINDS, type TransitionKind } from './portalTransition';

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
  /** Normalised gap below which the portal counts as "touching"/closed. */
  closeThreshold: number;
  /** Normalised gap above which the portal counts as re-opened (hysteresis). */
  openThreshold: number;
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
  collapseMs: number;
  /** Time held fully shut. The dimension swaps here; Phase 1 fires setPrompt here. */
  holdMs: number;
  reopenMs: number;
  /** Back-easing strength on the reopen. 0 = plain ease-out. */
  reopenOvershoot: number;
  /** Peak rotation for the `twist` variant, degrees. */
  twistDegrees: number;

  // --- sync (Phase 1 placeholder, §2.3) ------------------------------------
  /** Delay applied to the raw feed + mask to align with Lucy's stream. */
  syncDelayMs: number;

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

  contactMode: 'paired',
  closeThreshold: 0.35,
  openThreshold: 0.55,
  debounceFrames: 3,
  cooldownMs: 500,
  velocityEpsilon: 0.4,
  lostResetMs: 1000,

  feather: 6,

  transitionKind: 'shutter',
  collapseMs: 110,
  holdMs: 90,
  reopenMs: 240,
  reopenOvershoot: 1.1,
  twistDegrees: 90,

  syncDelayMs: 0,

  showLandmarks: false,
  showPolygonOutline: true,
  showPanel: true,
};

const STORAGE_KEY = 'portal.config.v1';

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
