/**
 * How the compensation delay is chosen (PRD §2.3 V2).
 *
 * Kept separate from `config.ts` so the config module stays free of anything
 * that pulls in the Decart SDK.
 */

export type SyncMode = 'off' | 'auto' | 'manual';

export const SYNC_MODES: SyncMode[] = ['off', 'auto', 'manual'];

export const SYNC_BLURBS: Record<SyncMode, string> = {
  off: 'live composite — portal contents lag the hands framing them',
  auto: 'follow the measured Δ, so the seam stays aligned as it drifts',
  manual: 'hold the Sync Δ slider value, whatever Δ actually does',
};
