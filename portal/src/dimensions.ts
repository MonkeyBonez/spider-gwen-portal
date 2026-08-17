/**
 * The dimensions the portal cycles through (PRD §6).
 *
 * `prompt` goes to `setPrompt` at the instant the portal is fully shut.
 * `color` fills the portal before Lucy's first frame decodes — the cold start
 * is 4–5s, so it is on screen for a real amount of time.
 *
 * **Right now this is a prompt-phrasing A/B, not six worlds.** All four entries
 * describe the same comic look and vary only in how it is asked for, so that a
 * close→open cycle steps between phrasings with everything else held constant.
 * Names say what varies rather than what it looks like, because the HUD chip is
 * the only way to tell which one is on screen when the outputs are similar.
 *
 * Prompt text is **verbatim as written by Sne**. Wording is the experiment, so
 * it does not get tidied — not the capitalisation, not the missing "is a" in
 * `mask-only`. See `PROMPT_LIBRARY` below for the six-world set this replaced.
 *
 * The two halves now differ in more than phrasing: the first two describe only
 * the person, the second two also describe the scene behind them. That is worth
 * watching specifically, because the portal is a small window onto the frame —
 * a background clause competes for very few pixels, and may show up mostly as a
 * change in colour and light on the subject rather than as a visible setting.
 */

export interface Dimension {
  name: string;
  color: string;
  prompt: string;
}

export const DIMENSIONS: Dimension[] = [
  {
    // No subject at all — pure rendering technique. The control: if this reads
    // as well as the others, the subject clause is not doing the work.
    name: 'style-only',
    color: '#ffffff',
    prompt: 'Comic-book animated, halftone shading, bold ink outlines',
  },
  {
    // Subject + costume + technique. The one that landed on the first run.
    name: 'style+subject',
    color: '#e0332c',
    prompt:
      'Comic-book animated superhero in a red-and-blue spider suit, halftone shading, bold ink outlines',
  },
  {
    // Names the subject and adds multiverse framing, with a background clause
    // but still no rendering instruction — so the look has to come from the
    // scene description alone.
    name: 'multiverse',
    color: '#2f7bff',
    prompt:
      'Subject is a Superhero in a red-and-blue spider suit in other part of multiverse - background is high tech',
  },
  {
    // The only one asking for a mask rather than a suit, and the only one
    // naming a concrete location. Two things to watch: whether it transforms
    // the face more and the body less, and whether a specific setting survives
    // — the portal is a small window, so most of a skyscraper falls outside it.
    name: 'mask-only',
    color: '#c84bff',
    prompt: 'Subject Superhero in a red-and-blue spider mask in a skyscraper',
  },
];

/**
 * The original six-world set from PRD §6, kept so it is not lost while the
 * phrasing A/B runs. Swap back by assigning this to `DIMENSIONS`.
 *
 * Note what separates these from the four above: each names a subject, what
 * they are wearing, *and* a rendering technique. `pixel` and `anime` are the
 * exceptions — they describe only a world, with no person in it, which is a
 * weak brief for a model whose job is transforming the person in frame.
 */
export const PROMPT_LIBRARY: Dimension[] = [
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
