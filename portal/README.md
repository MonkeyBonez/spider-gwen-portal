# Portal — Phase 1 (Lucy) in progress

Hand tracking, portal polygon geometry, and the gesture state machine, with a
**live Lucy stream composited inside the portal**. Each close→open cycle fires
`setPrompt` at the instant the portal is fully shut, so the dimension turns over
behind a closed window.

**Phase 0 exit criteria passed — tested by Sne, 2026-08-16.** The
re-verification steps below are kept for regressions.

## Run

```bash
npm install     # also fetches the WASM runtime + hand model (~20MB, gitignored)
cp .env.example .env.local   # then paste your Decart key into it
npm run dev     # http://localhost:5173
npm test        # state machine + geometry unit tests
```

Camera access needs a secure context — `localhost` covers desktop dev.

## The API key

Two ways in, checked in this order:

1. **`portal/.env.local`** — `VITE_DECART_API_KEY=...`. Gitignored. Read behind
   an `import.meta.env.DEV` guard, which Vite compiles to `false` for a
   production build, so the branch and the inlined key are dropped and **`dist/`
   cannot carry the key**. Dev convenience with the leak path closed.
2. **The start screen**, kept in localStorage. This is the path a real user
   takes (PRD Phase 2, BYO key) — leave `.env.local` blank to test it.

`.env.example` is the tracked template and must stay key-free. A
`.githooks/pre-commit` hook blocks env files and key-shaped strings; enable it
in a fresh clone with `git config core.hooksPath .githooks`.

## Cost

The Lucy stream bills **per generation-second**, so spending is deliberate:

- **"Camera only (free)"** on the start screen runs the entire gesture pipeline
  with a flat colour in the portal. Nothing connects, and the ~500kB LiveKit
  bundle isn't even downloaded.
- **`C`** connects or disconnects Lucy mid-session.
- **Idle disconnect** drops the stream after 60s with no hands (slider in the
  panel; `0` disables). Set against a 4–5s reconnect cold start, not zero.
- **`billed`** in the debug panel is the SDK's own `generationTick`, not a local
  clock.
- Closing the tab disconnects via `pagehide`.

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
| `C` | connect / disconnect the Lucy stream |
| `G` | save the session log (NDJSON) — same as the panel's "Save log" |
| `1`–`4` | pick the switch transition and play it immediately |

## Layout

| Path | Role |
| --- | --- |
| `src/handTracking.ts` | MediaPipe Tasks `HandLandmarker`, VIDEO mode, 2 hands, GPU |
| `src/lucy.ts` | Decart realtime session — connect, `setPrompt`, Δ/billing stats |
| `src/sessionLog.ts` | NDJSON recording of every SDK stat and event, for latency work |
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

## Re-verifying the exit criteria

All three passed on 2026-08-16. Re-run them after any change to geometry, the
trigger, or the thresholds:

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
together**, then reopens once they have moved apart past `releaseThreshold`. A fixed
hold can't know what the hands are doing, so it either blooms behind still-closed
hands or lags a fast cycle; this can't. `holdMs` applies to `timed` only.

**The hold is untimed.** Keep your hands together and the portal stays shut for as
long as you like. If it reopens on its own while your fingers haven't moved, something
is running on a clock — check the `transition` readout, which names the active timing,
and `held`, which shows how long the hold has run and whether a cap is set. The
`maxHoldMs` cap defaults to **off**; the real bail-out is *losing* the hands, which the
app detects directly and releases on.

**Three thresholds, easy to confuse:**

| Threshold | Default | What it does |
| --- | --- | --- |
| `closeThreshold` | 0.5 | how near counts as shut — fires the collapse **and the switch** |
| `releaseThreshold` | 0.6 | where the reopen begins. Above the close threshold on purpose, so the hands get a head start and the portal trails then catches up |
| `openThreshold` | 0.9 | re-arms for the next cycle. **Does not drive the animation** |

Raise `releaseThreshold` for more lag, drop it to `closeThreshold` for none. It is
clamped up to the close threshold (blooming while still counted shut makes no sense),
and above `openThreshold` it stops mattering — the fast-open catch fires there anyway
so a quick open can't lose the release.

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

## Reading the Lucy numbers (PRD §2.3.1)

In the debug panel while connected:

| Row | Means |
| --- | --- |
| `lucy` | session phase; `(no frames yet)` during the cold start |
| `Δ g2g` | **glass-to-glass latency — this is Δ.** Median, with p90 and sample count |
| `ttff` | connect → first frame. 4–5s is normal, per the SDK's own bands |
| `prompt ack` | round trip of the last `setPrompt`. The floor, not the settle time |
| `since prompt` | counts up from the last switch — **watch this while the portal turns over** |
| `billed` | generation seconds, straight from the SDK |

`prompt ack` and `since prompt` are there for PRD §7's open question: how long
Lucy takes to *visibly* settle after a prompt change. The ack says the request
landed; only your eyes say the pixels changed, so read the second number at the
moment the new dimension looks right.

Δ comes from the SDK's `stats` event, **not** `onConnectionQuality` — that one is
debounced to fire only when its verdict changes, so a HUD fed from it sits on a
stale number indefinitely.

### Where the latency is going

The rows below `ttff` follow a single frame's journey — our encoder, the wire,
their model, our jitter buffer, our decoder. Whichever is large is the one to
attack, and they are **completely different problems**:

| Row | If it's big | Fix |
| --- | --- | --- |
| `↑ encode` / `↑ limited by: bandwidth` | our uplink can't sustain the 3.5Mbps the SDK publishes at, so frames queue at the encoder | send fewer pixels — a downscaled track for Lucy while the canvas stays 720p |
| `↔ rtt`, `↔ path: relay` | routed through TURN instead of direct UDP | network / different connection |
| `≈ unaccounted` | Decart's inference. Their own median is ~285ms | nothing in this codebase — a different model, or design around it |
| `↓ jitter buf` | the receiver is holding frames to smooth out network variance | a playout-delay hint (needs SDK support — the LiveKit room isn't exposed) |
| `↓ decode`, `↓ inbound` freezes | this machine can't keep up decoding | codec / resolution |

**Watch whether Δ grows over a run.** A constant number is pipeline latency; one
that climbs is a buffer filling, which is a different and more fixable bug.

### Session log

`G`, or "Save log" in the panel, writes an NDJSON file: **every `stats` sample
the SDK emitted** (encode time, quality-limitation reason, jitter buffer, ICE
path, decode time), plus connection diagnostics, prompt changes, switches and
the camera settings actually granted — all on one clock.

This exists because latency debugging is retrospective. The question is always
"what was happening at the moment it felt bad", and by the time you notice, the
live HUD has moved on. One line per record, so `jq` and pandas both read it
directly:

```bash
jq -r 'select(.kind=="stats") | [.t, .data.glassToGlass.medianMs] | @tsv' portal-session-*.ndjson
```

The API key is never written to it — `scrub()` drops credential-shaped fields
before anything reaches the buffer, so these files are safe to share.

## Still to do in Phase 1

- **Sync.** `syncDelayMs` is in the config and on the panel but **not wired**.
  Whether it gets built at all depends on the measured Δ — see PRD §2.3, which
  now expects 300–600ms and treats V1-vs-V2 as an open decision rather than a
  formality.
- The canvas is locked to the camera's native resolution (1280×720 requested),
  which is exactly `lucy-2.5`'s output, so the composite needs no letterboxing.
  `drawCover` in `renderer.ts` handles the mismatch case anyway.
