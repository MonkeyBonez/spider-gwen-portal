/**
 * Publish codec for the Lucy session.
 *
 * Kept in its own module so `config.ts` does not have to import `lucy.ts`,
 * which pulls the Decart SDK in — the whole point of the dynamic import there
 * is that camera-only mode never downloads it.
 */

export type LucyCodec = 'h264' | 'vp8' | 'vp9';

export const LUCY_CODECS: LucyCodec[] = ['h264', 'vp8', 'vp9'];

export const LUCY_CODEC_BLURBS: Record<LucyCodec, string> = {
  h264: 'SDK default. Publishes 3 simulcast layers — observed encoding in software (OpenH264 ×3)',
  vp8: 'Still simulcast (the SDK only exempts vp9). A third data point, not a fix',
  vp9: 'The only setting that disables simulcast, so one encode instead of three',
};
