/**
 * The dimensions the portal cycles through (PRD §6).
 *
 * `prompt` goes to `setPrompt` at the instant the portal is fully shut.
 * `color` fills the portal before Lucy's first frame decodes — the cold start
 * is 4–5s, so it is on screen for a real amount of time.
 *
 * **The 2026-08-23 set, chosen by Sne.** It keeps the two known quantities from
 * the phrasing A/B, restores the *original* multiverse phrasing (the rewrite
 * from 2026-08-17 never got a run and is preserved in git history), and adds
 * two scene experiments: a named location and extra characters.
 * The open question has moved from "how do you phrase the suit" — answered:
 * lead with the costumed subject, name the technique — to "what beyond the
 * suit can a prompt add".
 *
 * Prompt text is **verbatim as written by Sne**. Wording is the experiment, so
 * it does not get tidied. See `PROMPT_LIBRARY` below for the six-world set
 * that preceded all of this.
 *
 * **Results, from the 2026-08-17 vp9 run** (frames pulled from the recorded
 * Lucy stream), for the entries that have run before:
 *
 * - `style-only` — restyles *him*: comic linework and flat colour on his real
 *   face, real clothes, real room. No costume at all. So the subject clause is
 *   what produces the suit; the technique words only change how it is drawn.
 * - `style+subject` — the full comic-book spider suit, heavy ink outlines, flat
 *   cel colour, room stylised to match. The most "animated Spider-Verse" of the
 *   set, and the closest to the trend. The reliable one.
 * - `multiverse` — intermittent: often failed to put him in the suit at all.
 *   When it did land it went photoreal game-cinematic, not comic — naming no
 *   rendering technique gave a 3D result, not a neutral one. Back in the set
 *   unchanged, to re-run against the new scene prompts on equal footing.
 *
 * On scene clauses, prior runs split: "background is high tech" rendered
 * clearly, "in a skyscraper" (from the retired `mask-only`) did not appear at
 * all. The distinction looks like texture-vs-place — a style word applies
 * across whatever is in frame, a specific location needs room the shot does
 * not have, since the subject fills it. `skyscraper` and `hangout` test
 * whether "on top of" or added characters fare any better.
 */

export interface Dimension {
  name: string;
  color: string;
  prompt: string;
}

export const DIMENSIONS: Dimension[] = [
  {
    // No subject at all — pure rendering technique. Known result: comic
    // linework on the real him, no costume. Kept as the control.
    name: 'style-only',
    color: '#ffffff',
    prompt: 'Comic-book animated, halftone shading, bold ink outlines',
  },
  {
    // Subject + costume + technique. The reliable one — the baseline the
    // scene experiments below are judged against.
    name: 'style+subject',
    color: '#e0332c',
    prompt:
      'Comic-book animated superhero in a red-and-blue spider suit, halftone shading, bold ink outlines',
  },
  {
    // The original multiverse phrasing, restored verbatim 2026-08-23. Known
    // intermittent (see header); back in for a fair re-run. The 2026-08-17
    // rewrite ("cinematic 3D render...") lives in git history if wanted back.
    name: 'multiverse',
    color: '#2f7bff',
    prompt:
      'Subject is a Superhero in a red-and-blue spider suit in other part of multiverse - background is high tech',
  },
  {
    // Named location. "in a skyscraper" never rendered; this asks for "on top
    // of" one — a rooftop reads as skyline texture behind the subject, which
    // may survive where an interior could not.
    name: 'skyscraper',
    color: '#c84bff',
    prompt:
      'Subject is a Superhero in a red-and-blue spider suit on top of a skyscraper',
  },
  {
    // The proven comic prompt plus extra characters. Tests whether Lucy can
    // add people who are not in the frame, or only restyle who is.
    name: 'hangout',
    color: '#2ecc71',
    prompt:
      'Comic-book animated superhero in a red-and-blue spider suit, halftone shading, bold ink outlines with a few other superheroes hanging out having a drink',
  },
];

/**
 * "Couples edition" — the same app pointed at a softer, cuter register.
 *
 * Added 2026-08-23 at Sne's request as a third way in from the start screen.
 * Nothing about the mechanic changes; only this list does. The Spider-Verse set
 * asks for one specific costumed character, which is a strange thing to hand
 * two people on a sofa — these ask for a *style* and leave the subjects alone,
 * so whoever is in frame stays themselves, just drawn differently.
 *
 * Note what these deliberately drop: no costume clause, no named character. By
 * the `style-only` result above that means the people are restyled rather than
 * transformed, which is exactly the point here. Prompt text is verbatim as
 * written by Sne, with one exception noted below.
 *
 * Untested as of 2026-08-23.
 */
export const COUPLES_DIMENSIONS: Dimension[] = [
  {
    name: 'chibi',
    color: '#ff8bd1',
    prompt: 'Cute chibi style',
  },
  {
    // The only one phrased as an instruction ("Restyle to...") rather than a
    // description. Worth watching against the others — the Spider-Verse set
    // found meta-language about the input grounded worse than a noun phrase.
    name: 'animated',
    color: '#8bc7ff',
    prompt: 'Restyle to animated movie',
  },
  {
    // Sne wrote "Chidlish"; corrected to "Childish" since a misspelling is a
    // slip rather than a phrasing choice, and the verbatim rule exists to
    // protect deliberate wording. Revert if the typo turns out to be the point.
    name: 'crayon',
    color: '#ffd166',
    prompt: 'Childish/cute Crayon style',
  },
  {
    name: 'watercolor',
    color: '#a6e3a1',
    prompt: 'Cute watercolor style',
  },
];

/**
 * The original six-world set from PRD §6, kept so it is not lost while the
 * prompt experiments run. Swap back by assigning this to `DIMENSIONS`.
 *
 * Note what separates these from the set above: each names a subject, what
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
