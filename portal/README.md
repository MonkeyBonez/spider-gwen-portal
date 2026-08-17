# Portal — Phase 0 POC

Proves hand tracking, portal polygon geometry, and the gesture state machine
end-to-end, with **no Lucy and no cost** (PRD §4, Phase 0). The portal is filled
with a solid colour as a 1:1 stand-in for a Lucy prompt; each close→open cycle
advances to the next dimension.

## Run

```bash
npm install     # also fetches the WASM runtime + hand model (~20MB, gitignored)
npm run dev     # http://localhost:5173
npm test        # state machine + geometry unit tests
```

Camera access needs a secure context — `localhost` covers desktop dev.

Target is **desktop browsers, Chrome on macOS first** (PRD §3.1). Safari on macOS is
worth checking before any demo, since its canvas `filter` and `MediaRecorder` support
diverge most. Mobile is a P2 bonus and shouldn't shape anything here; if you do want
to poke at it, `npm run dev` prints a LAN URL, but phones refuse the camera over plain
HTTP, so it needs a tunnel (`ngrok http 5173`) or an HTTPS dev server.

## Controls

| Key | Action |
| --- | --- |
| `D` | toggle the debug panel |
| `L` | toggle the landmark overlay |
| `Space` | play the transition manually. Under `gestural`, one tap collapses and the next reopens |
| `T` | flip the transition timing (`gestural` ↔ `timed`) |
| `R` | reset the switch counter and state machine |
| `1`–`4` | pick the switch transition and play it immediately |

## Layout

| Path | Role |
| --- | --- |
| `src/handTracking.ts` | MediaPipe Tasks `HandLandmarker`, VIDEO mode, 2 hands, GPU |
| `src/geometry.ts` | portal polygon, normalised `gap`/`area`, EMA smoothing |
| `src/triggers/types.ts` | `GestureTrigger` interface — swap in alternative strategies |
| `src/triggers/closeOpenTrigger.ts` | trigger v1, the PRD §2.2 state machine |
| `src/portalTransition.ts` | collapse/reopen animation on a switch (PRD §4.1) |
| `src/renderer.ts` | canvas compositing (layer + even-odd mask + feather) |
| `src/debugPanel.ts` | live thresholds, readouts, rolling gap plot |
| `src/dimensions.ts` | colour + prompt per dimension (prompts unused until Phase 1) |
| `/transitions.html` | all six transitions side by side on synthetic hands |
| `/tune.html` | **live** close-detection tuner — five triggers race on your real hands |
| `/closure.html` | close detection at five strictnesses side by side — drag the 4 points |
| `/verify.html` | standalone geometry harness — drag the 4 points |

## Verifying the exit criteria

PRD §4 Phase 0 sets three:

1. **Rectangle and bowtie cases render correctly.** Open
   `/verify.html` and drag `L-idx` below `L-thm`. The caption reports when the
   polygon is self-intersecting; the fill should resolve into two triangles with
   no gap or overdraw. Toggle the even-odd checkbox to see the nonzero rule get
   it wrong — that contrast is the actual proof. `test/geometry.test.ts` pins the
   traversal order and the self-intersection; only the fill *rendering* needs eyes.
2. **Exactly one switch per close→open cycle over ~20 cycles.** The HUD shows a
   running switch count; press `R` to zero it, then do 20 cycles and read it off.
   `test/trigger.test.ts` runs the same check against a synthetic 30fps gap trace,
   including noise, jitter at the threshold, and tracking dropouts.
3. **≥24fps on a laptop.** `fps` and `detect` (ms inside `detectForVideo`) are in
   the debug panel.

## Tuning

Thresholds in `src/config.ts` are the PRD's guesses. The panel's rolling plot
shows the normalised `gap` against the close (red) and open (green) lines — do a
few cycles, read the actual range off `gap min/max`, then set the close threshold
just above your closed value and the open threshold around the midpoint. Settings
persist to localStorage; "Reset settings" restores the defaults.

`Velocity ε` set to `0` disables the direction requirement, making the trigger a
pure threshold crossing. Worth A/B-ing — the velocity gate rejects slow drifts but
can miss very gentle closes.

### Contact mode (PRD §2.2.1)

Which cross-hand contacts count as closing the portal. Rotate one hand and its index
tip meets the *other* hand's thumb, so the original index↔index / thumb↔thumb rule
misses the close entirely.

- **`paired`** (default) — the better of the parallel or crossed pairing.
  Rotation-proof, and still needs both sides shut.
- **`any`** — the single closest cross-hand pair. Most forgiving. **Caveat:** if you
  perform the gesture with your thumbs pressed together as a pivot and swing your
  index fingers open, `any` reads the portal as shut for the whole cycle and
  switching stops. `paired` handles that correctly.
- **`strict`** — the original rule, kept only as a baseline.

The three are on different scales (`any` takes a minimum where `strict` takes a
mean), so **retune the close/open thresholds after changing mode** — don't carry the
numbers across. The panel readout `gap s/p/a` shows all three at once, so you can
watch how each responds to your actual hands before committing.

### Worst-side bias (PRD §2.2.1)

How the portal's two sides collapse into one `gap`. Averaging them lets a wide side be
cancelled out by a tight one: index fingers 0.6 hand-widths apart with the thumbs
touching averages to 0.30, under the 0.35 close threshold, so a plainly open triangle
fires the switch.

`Worst-side bias` interpolates away from that — `0` is the plain mean, `1` is exactly
`max`, meaning both sides must be shut and a long side vetoes the close outright.
In between, a long side forces the short one much smaller before the close counts.

**Symmetric poses read the same at every bias** (when both sides agree, mean and max
are the same number), so unlike a contact-mode change this can be tuned **without
retuning the thresholds**, and a normal four-points-together close is unaffected.

**Tune it at `/tune.html`** — the live one. Five independent copies of the real
trigger run at once, one per bias, all fed your actual hands, each keeping its own
switch count. Do ten deliberate close→open cycles, then deliberately do the sloppy
lopsided thing, and read off which bias counted ten and which over-counted. The
scatter plot shows where your real hands land in side-vs-side space, with the closed
region shaded — tune so the shaded corner covers the closes you meant and misses the
ones you didn't. Settings are the app's own (same localStorage), so whatever you land
on is what the app uses.

`/closure.html` is the same comparison without a camera: drag a synthetic pose, click
the *wide index · thumbs shut* preset, and the bias-0 panel reads CLOSED while the
rest read open — the whole bug and the whole fix on one screen. Useful for
understanding the rule; use `/tune.html` to actually pick the number.

Default is `0.7`, provisional until judged on real hands.

The switch always fires **on close**, never on opening — reopening only re-arms for
the next cycle. That is fixed, not a setting: the closed portal is the only moment
the swap is guaranteed to be masked, and it gives Lucy the whole closed period to
settle before the hands reveal it.

## Switch transitions (PRD §4.1)

On a switch the portal collapses, holds shut, and reopens onto the live fingertips.
The dimension changes at the low point, so it is never seen mid-flight — the mask is
guaranteed by the animation rather than by how well the hands happened to occlude
the portal.

**Settled: `iris`, driven `gestural`.** `shutter`, `twist` and the `timed` path stay
selectable as controls.

`gestural` splits the animation into two independently triggered halves: it collapses
when the four points come together and **stays shut for as long as they stay
together**, then reopens the moment they start moving apart. A fixed hold can't know
what the hands are doing, so it either blooms behind still-closed hands or lags a fast
cycle; this can't. `holdMs` applies to `timed` only — under `gestural` the only timer
is `maxHoldMs`, a safety valve for hands leaving the frame while shut.

Press `T` to flip timing live, or compare on synthetic hands at `/transitions.html`:
push `hold shut` up and watch `timed` reopen behind the closed hands while `gestural`
waits.

Compare them at **`/transitions.html`**: they run side by side on identical
synthetic hands, so the only difference you see is the transition itself. The dashed
outline marks where the fingertips are; the `hand speed` slider is the important one,
because it changes how much of the transition survives the hands moving underneath it.

In the live app, `1`–`6` switch variant and play it instantly, so you can compare
back to back with your hands held still.

The timing sliders matter more than the variant choice — a reopen tween close to your
hand-opening speed (~150–250ms) is nearly invisible. Push it slower for a portal that
lags and catches up, or faster for one that beats the hands open.

## Notes for Phase 1

- `renderer.ts` already composites through an offscreen layer + mask, so Lucy
  drops in by replacing the `fillRect` with `drawImage(lucyVideo, …)`.
- `dimensions.ts` carries the §6 prompt strings; the advance path becomes
  `setPrompt(DIMENSIONS[i].prompt)` on the trigger's `closed` signal.
- `syncDelayMs` is in the config and on the panel but is **not yet wired** — the
  §2.3 V2 ring buffer is Phase 1 work.
- The canvas is locked to the camera's native resolution (1280×720 requested) to
  match Lucy's 720p output (PRD §7).
