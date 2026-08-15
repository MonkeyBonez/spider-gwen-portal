/**
 * Phase 0 dimensions: a solid colour per dimension, standing in 1:1 for the
 * Lucy prompt library (PRD §4 Phase 0, §6).
 *
 * In Phase 1 the renderer draws Lucy's stream instead of `color`, and the
 * `prompt` field is what gets handed to `setPrompt` — the cycling logic is
 * unchanged.
 */

export interface Dimension {
  name: string;
  color: string;
  prompt: string;
}

export const DIMENSIONS: Dimension[] = [
  {
    name: 'Comic',
    color: '#ffffff',
    prompt:
      'Comic-book animated superhero in a red-and-blue spider suit, halftone shading, bold ink outlines.',
  },
  {
    name: 'Noir',
    color: '#e0332c',
    prompt:
      'Noir black-and-white detective world, dramatic rain and shadows, monochrome suit.',
  },
  {
    name: 'Neon',
    color: '#2f7bff',
    prompt: 'Futuristic neon cyber city, glowing pink-and-blue tech suit.',
  },
  {
    name: 'Watercolour',
    color: '#2ecc71',
    prompt: 'Watercolor storybook world, soft pastel spider-hero.',
  },
  {
    name: 'Pixel',
    color: '#c84bff',
    prompt: 'Retro pixel-art / 8-bit game world.',
  },
  {
    name: 'Anime',
    color: '#ffb020',
    prompt: 'Golden-hour anime film style, hand-drawn look.',
  },
];
