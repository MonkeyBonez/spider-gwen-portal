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
| `Space` | advance the dimension manually (plays the full transition) |
| `R` | reset the switch counter and state machine |
| `1`–`6` | pick the switch transition and play it immediately |

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

`Advance on` picks when the trigger fires: `closed` (default) starts the transition
while the hands are shut, which is what Phase 1 wants so Lucy's transition frames
stay hidden; `opening` fires as the hands part, matching the literal wording of
PRD §2.2.

## Switch transitions (PRD §4.1)

On a switch the portal collapses, holds shut, and reopens onto the live fingertips.
The dimension changes at the low point, so it is never seen mid-flight — the mask is
guaranteed by the animation rather than by how well the hands happened to occlude
the portal.

Compare them at **`/transitions.html`**: all six run side by side on identical
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
