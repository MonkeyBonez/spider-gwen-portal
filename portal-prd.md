# Portal — Real-Time Spider-Verse Dimension Portal (PRD + Build Context)

**Status:** Phase 0 POC built (`portal/`). This document is the full context for the project. Read it entirely before writing code.
**Owner:** Sne
**Last updated:** 2026-08-15

---

## 1. What we're building and why

There's a viral trend (the "Spider-Gwen trend," sparked by the recent live-action Spider-Man movie riffing on the animated Spider-Verse multiverse) where creators film a selfie video, bring both hands together in front of the camera — thumbs touching, index fingers touching — and open/close their hands like a window. Each time the hands open, the gap between them appears to reveal "another dimension": an AI-generated Spider-Verse version of themselves, mirroring their motion. Each close→open cycle reveals a *new* dimension/variant.

Today, creators do this manually: record video → screenshot frames → generate AI images of themselves → feed into an image-to-video tool (e.g. Higgsfield) → hand-composite the result frame by frame. It's a very high lift.

**Our product collapses that entire workflow into a live browser experience.** Open a website, allow camera access, do the hand gesture, and the portal effect happens in real time — live AI video inside the portal, new dimension on every open. Record and post.

---

## 2. Core technical concept

Three pieces, composited together in the browser:

1. **Raw camera feed** — the user, unmodified.
2. **Portal mask** — a polygon computed each frame from 4 hand landmarks (left/right thumb tips + left/right index fingertips), tracked via MediaPipe Hand Landmarker running locally in the browser.
3. **Transformed feed** — the *same* camera feed sent to Decart's Lucy realtime video-to-video model over WebRTC, which returns the full frame restyled per a text prompt (e.g. "anime Spider-Verse superhero version of this person"). Lucy transforms whole frames; it is NOT an inpainting model.

**Compositing rule:** inside the portal polygon, show Lucy's transformed stream; outside it, show the raw feed. Because Lucy's output is the user's own feed restyled, the "other dimension" self naturally mirrors the user's motion — no motion transfer needed.

### 2.1 The portal polygon

- MediaPipe Hand Landmarker returns 21 landmarks per hand. We use:
  - Landmark **4** = thumb tip
  - Landmark **8** = index fingertip
- Connect the 4 points in fixed order: **L-index → R-index → R-thumb → L-thumb**, close the path, fill with the **even-odd rule**.
- When hands are level (both index fingers above thumbs), this renders a quad/rectangle.
- When one hand rotates (e.g. left index points down), the quad self-intersects into a bowtie; even-odd fill renders it as the correct **two-triangle** shape automatically. **No special-case geometry logic is needed.** Verify this visually in the POC.
- Handedness: use MediaPipe's handedness classification to assign left vs. right. Handle the mirror-mode ambiguity (front camera is typically mirrored — test and make consistent).
- Only render the portal when **both hands are detected with sufficient confidence** (e.g. presence confidence ≥ 0.6). If a hand drops out, fade/hide the portal gracefully rather than glitching.
- Smooth landmark jitter with a light exponential moving average (EMA) on the 4 points (tunable α, start ~0.5). Portal edges may also get a soft feather/blur (a few px) so the composite doesn't look razor-cut.

### 2.2 Gesture state machine (dimension switching)

The prompt (dimension) advances on each close→open cycle. Proposed state machine — build it so trigger logic is **pluggable/configurable**, because we want to experiment:

States: `OPEN → CLOSING → CLOSED → OPENING → OPEN`

Signals per frame:
- `gap` = separation between the two hands, normalized by hand size (e.g. wrist-to-middle-MCP distance) so it's camera-distance invariant. **How that separation is measured is configurable — see §2.2.1, which supersedes the original "mean of index↔index and thumb↔thumb" definition.**
- `area` = polygon area, similarly normalized. **Note:** this is a weak signal and must not be the primary trigger input — for a rotated hand the polygon is a bowtie whose two lobes have opposite winding, so the shoelace area cancels to ~0 while the portal is plainly open. Keep it as a readout.
- Velocity of `gap` (moving together vs. apart).

Logic v1 (Sne's idea):
- When fingertips are moving together AND `gap` drops below a "touching" threshold → mark `CLOSED` (set a flag).
- **Advance to the next prompt at that moment — on close, always.** This is settled; do not make it configurable and do not fire on opening. An earlier draft of this document proposed advancing "at the moment of opening"; that is superseded.
- Reopening does not fire. It only re-arms the trigger for the next cycle, which is what guarantees one switch per close→open cycle.
- Debounce: require `CLOSED` to hold for N frames (start N=3) before it can trigger; cooldown of ~500ms between switches to prevent rapid-fire flapping.

Why close and not open: the swap has to be masked, and the closed portal is the only moment we can guarantee it is. Firing on close also hands the model the entire closed period to settle. Lucy 2.5 supports changing the prompt mid-stream on a live connection (`setPrompt` / `realtimeClient.set({prompt})`) with near-instant adaptation — so `setPrompt` fires on the CLOSED flag, and by the time the hands open, the new dimension has settled. Firing on open would expose the model's transition frames at exactly the moment the portal becomes visible, which is the one thing this design is trying to avoid.

This pairs with the §4.1 collapse animation, which makes the masking our guarantee rather than the performer's: the portal is at zero visible area when the swap lands regardless of how well the hands occluded it.

**Thresholds are guesses. Build a debug panel** (see §5) to tune them live.

#### 2.2.1 Contact detection: which fingers count as "touching"

The original rule — index↔index **and** thumb↔thumb — assumes both hands stay level
and identically oriented. They don't. Rotate one hand and its index tip ends up
meeting the *other hand's thumb*; the hands are pressed together and the portal is
visibly shut, but both of the measured distances are still wide, so the close is
never detected and the dimension never advances. **Contact must be detected between
any two points on opposite hands, not just matching landmarks.**

Same-hand pairs are always excluded — an index touching its own thumb is a pinch,
and says nothing about whether the two hands have met.

Three modes, selectable at runtime so they can be compared on real hands:

| Mode | `gap` is | Behaviour |
| --- | --- | --- |
| `strict` | mean of index↔index and thumb↔thumb | The original rule. Kept only as a baseline to compare against; it has the bug described above. |
| `paired` | the smaller of the **parallel** pairing (index↔index, thumb↔thumb) and the **crossed** pairing (index↔thumb, thumb↔index) | **Default.** Rotation-invariant, but still a mean over two pairs, so both sides of the portal have to be closed for it to read as shut. |
| `any` | the single closest cross-hand pair | The literal "any two points touching". Most forgiving; carries the hinge caveat below. |

**The hinge caveat, which is why `any` is not the default.** A natural way to perform
this gesture is to keep the thumbs pressed together as a pivot and swing the index
fingers open like a book. Under `any`, the touching thumbs hold `gap` near zero for
the entire cycle — the portal never reads as open, so the state machine never
re-arms and switching stops dead. `paired` handles this correctly because it needs
both pairs closed. If `any` is chosen anyway, the thumb-pivot performance has to be
ruled out during testing.

**The three modes are on different scales.** `any` takes a minimum where `strict`
takes a mean, so it reports roughly half the value for the same pose. The close and
open thresholds must be retuned whenever the mode changes — do not carry numbers
across. The debug panel shows all three values simultaneously (`gap s/p/a`) so the
choice can be made by observation.

### 2.3 Sync / latency alignment

- Lucy realtime is marketed at sub-40ms inference latency at 30fps over WebRTC; real end-to-end latency = inference + network RTT, and will vary. Treat total delay as an unknown to measure, not a constant.
- The portal mask is computed locally (~1 frame). The Lucy stream arrives delayed. If we composite naively, the transformed self lags the mask.
- **Approach, in order:**
  1. **V1: composite live, no compensation.** May look fine at small delays. Ship this first and evaluate visually.
  2. **V2: delay the raw feed + mask by an estimated Δ** to align with Lucy's stream. Implement a ring buffer of (frame, landmarks, timestamp) and render from `now − Δ`. Δ is a user-tunable slider in the debug panel (0–500ms). Investigate whether the Decart SDK exposes latency/stats (WebRTC `getStats()` RTT is a fallback estimator).
     - **Where the estimate comes from:** the onboarding calibration gesture (§4.3) measures Δ directly — the user is cued between two known hand positions, and we time how long that move takes to appear in the returned stream. That is a real end-to-end number on this network, not a guess. The slider stays regardless; measured-once vs. re-measured vs. fixed vs. no compensation are options to A/B, not a settled choice.
  3. Note: delaying the *entire displayed output* by Δ is acceptable — the user is performing to camera, a uniform ~100ms display delay is not noticeable in the recording.

---

## 3. Tech stack

- **Frontend:** Single-page web app. React + Vite (or plain TS if simpler). No backend required for POC/MVP — everything runs client-side except Lucy's cloud inference.
- **Hand tracking:** `@mediapipe/tasks-vision` npm package → `HandLandmarker`, `runningMode: "VIDEO"`, `numHands: 2`, GPU delegate (WASM/WebGL). Model asset: the official `hand_landmarker.task` float16 bundle from Google's storage CDN. (Do NOT use the legacy TensorFlow.js handpose or legacy MediaPipe Hands solution — use the current Tasks API.)
- **AI video:** `@decartai/sdk` → `client.realtime.connect(stream, { model: models.realtime("lucy-2.5"), ... })`. WebRTC-based; returns a transformed MediaStream via `onRemoteStream`. Prompt changes mid-session via `realtimeClient.setPrompt(...)` (await server ack). Output is 720p; request camera at the model's specified width/height/fps.
  - Model choice: default **lucy-2.5** (general realtime editing, best prompt-following). **lucy-restyle-2** is a fallback/alternative to A/B for full-scene restyling. Check current model IDs in Decart docs at build time.
- **Compositing:** `<canvas>` (2D context is likely sufficient; WebGL if perf demands). Per displayed frame: draw raw video → set clip path to portal polygon (even-odd) → draw Lucy video inside clip. Feathered edge via shadow/blur trick or offscreen mask canvas.
- **Recording (MVP 1.5):** `canvas.captureStream(30)` → `MediaRecorder` → webm (mp4 via muxer lib if needed for social apps). Include mic audio track optionally.

### 3.1 Target platforms

**Desktop/laptop browsers are the priority. Mobile web is a hoped-for bonus, not a
requirement, and must never drive a design decision.**

| Tier | Platform | Commitment |
| --- | --- | --- |
| **P0** | Chrome on macOS (dev machine — Apple silicon) | Must work. Every exit criterion is measured here. |
| **P1** | Safari on macOS | Should work. Verify before any demo, since Safari's canvas/WebRTC behaviour diverges most. |
| **P1** | Chrome/Edge on Windows | Should work. No hardware here to test on; treat as unverified until someone runs it. |
| **P2** | Mobile Safari (iOS), Chrome (Android) | Try it, report what happens, fix only what is cheap. Failing here does not block a release. |

What this means in practice:

- Performance targets, resolution choices, and the canonical canvas size (§7) are set
  by what a laptop can sustain. Do not down-res or simplify the desktop path to make a
  phone happy.
- Do not build mobile-specific UI, orientation handling, or touch affordances until
  desktop is finished and someone asks for them.
- `getUserMedia` needs a secure context everywhere, so `localhost` covers desktop dev.
  Testing on a phone needs a tunnel or an HTTPS dev server — that is a real setup cost
  and another reason to keep mobile out of the inner loop.
- If mobile turns out to work for free, good. If it needs its own rendering path, that
  is a separate project, not a Phase 1.5 task.

Not targeted: legacy browsers, in-app webviews (Instagram/TikTok browsers), Firefox on
any platform (untested, no commitment either way).

---

## 4. Phased plan

### Phase 0 — POC (no Lucy, no cost)
Goal: prove hand tracking, polygon geometry, and the gesture state machine end-to-end.
- Webcam feed + MediaPipe Hand Landmarker.
- Draw the portal polygon filled with a **solid color** (green-screen stand-in).
- Gesture state machine: each close→open cycle switches the fill color (white → red → blue → ...). This is a 1:1 stand-in for prompt switching.
- Debug panel with live thresholds, landmark visualization toggle, FPS counter, state readout.
- **Switch transition:** the portal collapses and reopens onto the fingertips whenever the dimension changes (Sne's idea, see §4.1).
- **Exit criteria:** rectangle and bowtie cases render correctly; color reliably switches exactly once per close→open cycle across ~20 consecutive cycles; ≥24 fps in Chrome on the macOS dev laptop (the P0 target, §3.1).

#### 4.1 Switch transition: collapse and reopen

When the dimension changes, the portal stops tracking the fingertips for a beat:
it **collapses shut, holds, then reopens onto wherever the fingers now are**, tweened.

Why this is worth building in Phase 0 rather than treating it as polish: §2.2's plan
for hiding the model's transition frames is "swap while the hands are closed, so the
closed hands occlude it." That works only as well as the performer's gesture does. A
sloppy close, a fast cycle, or a hand that drifts leaves the swap visible. A forced
collapse makes the mask **our** guarantee instead of the performer's — the portal is
provably at zero visible area at the instant the swap lands, regardless of where the
hands are. It also gives the switch a deliberate beat, which reads better on camera
than an instant cut.

This refines the timing rule from §2.2. The trigger still fires on close, but it no
longer performs the swap itself — it *starts* the transition, and the swap happens at
the collapse's low point a few frames later. In
Phase 1, `setPrompt` fires there, and the hold duration becomes the knob for however
long Lucy needs to settle (§7's open question) — lengthen the hold, not the gesture.

**The variable that actually matters** is not which shape it collapses to, but how the
transition's duration compares to the hand motion underneath it. Hands open in roughly
150–250ms. A reopen tween of about that length is invisible — the portal just tracks
the fingers as it always did. The effect only reads if the portal is *decoupled*:
noticeably slower than the hands (the portal lags, then catches up) or snappier
(the portal is already open before the hands are). Tune duration first, pick the shape
second.

**Shortlisted to three.** A wider set was prototyped (an eyelid drop and a sideways
wipe); those are cut. The remaining three stay in and the choice between them is
**deferred until the MVP**, decided on feel once the hold can be tuned against Lucy's
real settle time rather than against a flat colour fill:

| Variant | Collapses to | Reads as |
| --- | --- | --- |
| `shutter` | a vertical slit on the midline | the hands themselves closing — physically congruent. Current default. |
| `iris` | a point at the centre | camera shutter / lens; mechanical rather than bodily |
| `twist` | a point, while rotating | a wormhole spinning shut |
| `none` | — | not a fourth variant — the off switch, kept as the control case |

Timing and overshoot are sliders, not variants — a hard collapse with a slow bloom and
a strong overshoot is a very different feel from a symmetric ease, using the same shape.

Open questions to settle by looking at them:

- Does the transition survive being filmed, or does it read as a glitch? The control
  case (`none`) exists to answer this honestly — it is possible the cleanest result is
  no animation at all, with the hands doing the masking as originally planned.
- Should the reopen track the live fingertips (current behaviour) or reopen to the
  fingertip positions *captured at collapse*? The former keeps the portal glued to the
  hands; the latter would let the portal open somewhere the hands no longer are, which
  might look broken or might look great.
- A slice/glitch-shatter transition — the portal breaking into offset bands before
  reassembling — is the most on-trend option for this aesthetic, but it needs a
  different geometry representation than the 4-point polygon. Deferred, not dismissed.

### Phase 1 — MVP (Lucy integration)
Goal: replace solid color with live Lucy stream.
- Connect one persistent Lucy realtime session when the user hits "Start" (single stream — do NOT run parallel streams; `setPrompt` replaces the need for pre-warmed backup streams).
- Prompt library of ~6 Spider-Verse dimension prompts (see §6); cycle via `setPrompt` on CLOSED.
- Composite per §2. V1 sync (no compensation), then V2 delay buffer if needed.
- Disconnect Lucy on Stop/idle timeout (billing is per generation-second — never leave a stream running).
- **Exit criteria:** full trend effect works live; prompt visibly changes each cycle; transition artifacts hidden by closed hands.

### Phase 1.5 — Recording & export
- Record button → MediaRecorder on the composited canvas (+ mic).
- Download file; countdown timer; basic UX polish (start screen, camera permission flow). Verify export works in Safari on macOS, not just Chrome — codec support differs. An unsupported-browser notice is enough for anything outside the §3.1 tiers; no mobile-specific work here.
- **Performer HUD — hand skeleton as a dimension indicator** (Sne's idea, see §4.2).
- **Onboarding / calibration tutorial** — teach the gesture, confirm hands are in frame, and measure thresholds and latency from two cued hand positions (Sne's idea, see §4.3).
- **Exit criteria:** exported file contains the composite only — no skeleton, no HUD, no debug overlay. A first-time user can get a working take without being told how the gesture works.

#### 4.2 Performer HUD: skeleton dimension indicator

The problem this solves: while filming, the creator is looking at the screen from
behind their own hands and can't easily tell *which* dimension is currently loaded,
or confirm that a close→open cycle actually registered a switch. Right now the only
feedback is the portal contents themselves, which are occluded at exactly the moment
the switch fires.

So: draw the MediaPipe hand skeleton (the 21 landmarks and their connections, as
vectors) over the live preview, and **recolour the skeleton per dimension**. When the
state machine advances, the skeleton snaps to the new dimension's accent colour. That
reads as the two hands being "wired into" whichever universe is currently showing
through the portal — the hands are the frame of the portal, so colouring them is a
natural signal that the portal's contents changed.

Requirements:

- **Preview-only. It must never appear in the exported video.** This is a hard
  constraint and it dictates the architecture: the composite canvas that
  `captureStream()` records must contain *only* the raw feed + portal. The skeleton
  goes on a **second, transparent canvas layered over the first via CSS** — same
  dimensions, same coordinate space, absolutely positioned on top, never captured.
  Do not draw the skeleton into the composite canvas and try to erase it before
  recording; keep the two surfaces separate from the start.
- One accent colour per dimension, defined alongside its prompt in the prompt
  library so the two can never drift out of sync.
- Colour change should be legible at a glance but not distracting: consider a brief
  brighter flash or a short thickness pulse on the switch frame, settling to a
  steady, semi-transparent line. Tune opacity so it doesn't fight the portal.
- Toggleable, and default-on during recording setup. Some creators will want a clean
  preview; some will want it while rehearsing and off for the real take.
- This is a superset of the Phase 0 debug landmark overlay — fold that overlay into
  this component rather than maintaining two skeleton renderers. The debug version
  keeps its per-hand handedness/confidence labels; the performer version is just the
  coloured vectors.

Open questions:

- Does the skeleton read better on both hands, or only on the 4 portal points
  (thumb tips + index tips) plus the polygon edge? The full 21-point skeleton may be
  visually noisy against a busy transformed portal — prototype both.
- Worth also flashing the portal's *outline* in the dimension colour for one beat on
  switch? Cheaper than the full skeleton and might be enough on its own.
- If we later want this baked into some exports (it might read as an intentional
  stylistic effect rather than a debug affordance), it becomes a per-export toggle:
  record from a third canvas that composites both layers. Note only; not now.

#### 4.3 Onboarding: the tutorial / calibration gesture

Before the first real take, walk the user through the gesture once. This is a UX
requirement and a technical one at the same time — the same 10 seconds that teach the
gesture also hand us three measurements we currently have to guess at.

**The flow, in order.** Structure it as **two named, held positions** rather than
"do the gesture a few times" (Sne's refinement). We ask for position 1, we cue the
move, we ask for position 2 — and because we chose both the shapes and the moment, we
know exactly what to look for and when. That is what makes the latency measurement
tractable; see below.

1. **Show your hands.** Nothing starts until both hands are detected. Draw an
   alignment guide on the preview — a ghost outline of the portal shape at a
   comfortable size and position — and ask the user to line their hands up with it.
   Advance when both hands are tracked, roughly on the guide, and stable for ~1s.
2. **Position 1 — portal open.** The wide pose: thumbs and index fingers apart,
   framing an open window. Hold it for ~1s while we confirm the shape is stable.
3. **Cue the move, on our timing.** A visible countdown or beat, then "now close."
   The cue matters as much as the poses — it is the moment we start the clock.
4. **Position 2 — portal closed.** Thumbs together, index fingers together. **This
   pose is the start of the close, so position 2 *is* the trigger pose** — the tutorial
   is not a mime of the gesture, it is the gesture. Hold ~1s.
5. **Rehearse the full cycle.** Now open and close ~3 more times freely. Confirm each
   one visibly (the switch counter ticks, the skeleton recolours per §4.2, the
   transition plays). This is where the user learns what a registered switch looks and
   feels like, which is what stops them performing a whole take unaware that nothing
   is firing.
6. **Then start.** Only now offer Record.

Steps 2–4 are the measurement; step 5 is the lesson. They can be presented as one
continuous instruction ("open… and close… good, now do that a few times") so it reads
as a single 10-second onboarding rather than a test followed by a tutorial.

**Why this is not just a tutorial.** The two positions and the rehearsal cycles are a
calibration sample, and we should use them for all three of the things we are
otherwise hand-tuning:

- **Gesture thresholds (works from Phase 0, no Lucy needed).** Position 1 gives this
  user's real open `gap`; position 2 gives their real closed `gap` — with their hands,
  their camera distance, their contact mode, held still enough to average over. Fit
  `closeThreshold` and `openThreshold` to that measured range instead of shipping the
  global guesses in §2.2. Everyone's hands are a different size and everyone sits a
  different distance from the laptop; this removes the single most likely cause of "it
  doesn't work for me."
- **End-to-end latency Δ (Phase 1, needs Lucy connected).** See below.
- **Framerate under real load.** The rehearsal runs the full pipeline with the user
  actually moving, so it is a better perf sample than an idle preview. If we are below
  the §4 Phase 0 bar here, say so before they record rather than after.

**How to measure Δ.** The two-position structure is what makes this work. A free-form
"do the gesture" gives us an event we have to go hunting for in the returned stream.
A commanded move between two known poses gives us three things instead: a **known
start shape**, a **known end shape**, and a **known cue time**. So we are not
detecting an arbitrary event — we are asking "when did the returned stream stop
looking like position 1 and start looking like position 2?", inside a narrow window
that begins at the cue. Both poses are held, so we can average over many frames rather
than trusting one, and the transition between two distinct held states is about the
easiest signal there is to timestamp.

In preference order:

1. **Landmark-based.** Run a second `HandLandmarker` pass on the *returned* Lucy video
   for the duration of the calibration only, and compare when `gap` crosses the
   midpoint between the measured position-1 and position-2 values in each signal. Most
   precise, and the threshold is already calibrated by the poses themselves. Risk: a
   heavy restyle may render hands the detector can't track (see §7) — detect that and
   fall back rather than reporting a confidently wrong number.
2. **Pose-template correlation.** Skip landmarks: take a small downscaled grayscale
   template of each held pose from the *returned* stream, then score every frame in
   the window against both. Δ is where the score crosses over. Works even if the
   restyle makes hands unrecognisable to a detector, because we are matching the
   output against itself, not against an idea of what a hand looks like.
3. **Motion-energy cross-correlation.** Reduce both streams to a scalar per frame
   (mean absolute frame difference) and find the lag maximising correlation across the
   window. Crudest, most robust, no assumptions at all — the move between the two
   poses is a large brief whole-frame motion spike. Good enough as a sanity check on
   the other two even if it isn't the primary.
4. **Manual slider.** Always keep it. Whatever we measure is a starting value, not a
   lock — the panel's Δ slider (§2.3, §5) stays, and the user can nudge it.

Repeat the two-position move ~3 times and take the median, not a single sample; one
measurement on a jittery network is worth very little.

Treat the measured Δ as **one option among several to A/B later**, not a solved
problem: measured-once, re-measured periodically during a session, a fixed value
picked by feel, and no compensation at all (§2.3 V1) are all live candidates, and
which one looks best is an empirical question we should not pre-judge here.

**Constraints and open questions:**

- Skippable, and remembered. A returning user should not sit through the tutorial
  every session — offer "recalibrate" instead. But re-run the alignment check (step 1)
  every session regardless; it costs a second and it catches the camera being at a
  different distance today.
- **Does the tutorial's close count as a real switch?** Position 2 is the trigger
  pose, so the state machine will fire on it unless we suppress it. Decide
  deliberately: suppressing keeps the user's first recorded take starting on dimension
  1, while letting it fire makes the rehearsal a truthful preview of the real thing.
  Leaning toward letting it fire during the rehearsal cycles (step 5) and resetting
  the dimension index when recording starts.
- Calibration must not cost Lucy time. Steps 1 and 5 need no model at all; only the Δ
  measurement (steps 2–4) does. Either run the whole tutorial pre-connect and take the
  Δ samples in the first seconds after connecting, or connect just before step 2. Do
  not hold an open billed stream through an explanatory screen (§2 Phase 2 cost
  hygiene).
- If a user cannot get a single cycle to register during rehearsal, that is the
  clearest possible diagnostic signal and we should react to it in-product — suggest
  moving back from the camera, improving the lighting, or trying `swapHandedness` —
  rather than dropping them into a broken session.
- Open: does the alignment guide help or annoy? A fixed ghost outline enforces a
  framing that may not suit everyone's arm length. The alternative is no guide, just
  "get both hands in frame." Prototype the guide, but be willing to cut it to a simple
  hands-detected indicator.

### Phase 2 — BYO key & cost model
- User pastes their own Decart API key (stored in localStorage only, never sent to any server of ours). Their usage bills to their account.
- Later option: hosted accounts where users pay us and we pay Decart — requires backend, auth, metering. Out of scope for now; note only.
- Cost hygiene: idle detection (no hands detected for 20s → pause/disconnect Lucy), session timer visible to user, estimated cost readout if Decart exposes usage ticks (the SDK exposes `generationTicks`).

---

## 5. Debug panel (build in Phase 0, keep behind a flag)

- Landmark overlay on/off; portal polygon outline on/off. (In Phase 1.5 this overlay grows into the performer-facing skeleton indicator — see §4.2 — so build it as one component, not two.)
- Selectors: contact mode (§2.2.1), switch transition (§4.1).
- Sliders: EMA α, close threshold, open threshold, debounce frames, cooldown ms, sync delay Δ, transition collapse/hold/reopen/overshoot (§4.1).
- Readouts: FPS, state machine state, normalized gap/area, `gap` under all three contact modes at once, Lucy connection state, generation seconds used.
- Calibration (§4.3): a "run calibration" button, the measured position-1/position-2 `gap` values and the thresholds fitted from them, and the measured Δ per sample plus the median actually in use. Measured values must be visibly distinguishable from defaults, and overridable by the sliders above.

## 6. Initial prompt library (iterate later)

Written for a video-to-video restyle model — describe the transformation of the person in frame, keep scene/motion intact. Examples to start (tune wording against Lucy's prompt guide):
1. Comic-book animated superhero in a red-and-blue spider suit, halftone shading, bold ink outlines.
2. Noir black-and-white detective world, dramatic rain and shadows, monochrome suit.
3. Futuristic neon cyber city, glowing pink-and-blue tech suit.
4. Watercolor storybook world, soft pastel spider-hero.
5. Retro pixel-art / 8-bit game world.
6. Golden-hour anime film style, hand-drawn look.

(IP note: avoid trademarked character names in prompts and product copy; describe styles generically. Product name should not use "Spider-Man"/"Spider-Verse" marks.)

## 7. Known risks / open questions

- **Lucy prompt-transition behavior:** how many frames does a `setPrompt` take to fully settle? Measure; if slow, lengthen the required CLOSED hold or crossfade inside the portal.
- **Lucy latency variance** on real networks; the Δ-buffer is the mitigation, and §4.3's calibration gesture is how Δ gets a real number. Open: Δ may drift *during* a session, in which case a one-shot measurement at the start is not enough and we need periodic re-measurement or a continuous estimator.
- **Hands may not be trackable in Lucy's output.** §4.3's preferred latency measurement runs a second `HandLandmarker` pass on the returned stream, which assumes the restyled hands still look like hands. A heavy stylisation (pixel-art, watercolour) may break that. Mitigation is already in the design — fall back to pose-template or motion-energy correlation — but detecting the failure rather than silently reporting a wrong Δ is the part to get right.
- **Hands inside Lucy's output:** Lucy transforms the whole frame including hands — this is fine (inside the portal you *want* transformed hands), but check edge seams where transformed hands meet real hands at the polygon boundary; feathering should help.
- **Cross-browser desktop support (the risk that actually matters):** Safari on macOS is the one to watch — canvas `filter` (used for the portal feather), `captureStream`, and `MediaRecorder` codec support all differ from Chrome's, and `MediaRecorder` webm output in particular is historically weak there. Test the composite and the Phase 1.5 export in Safari before demoing. Chrome on macOS is the reference implementation.
- **Mobile browser support (P2, non-blocking):** MediaPipe tasks-vision + WebRTC both work on modern mobile browsers in principle, but this is explicitly not a launch requirement (§3.1). Expect the real obstacles to be sustained framerate under thermal throttling and iOS Safari's camera/autoplay quirks. Try it once the desktop path is done; do not let findings here reshape the desktop build.
- **Resolution mismatch:** Lucy outputs 720p at a fixed aspect; camera/canvas must match or be letterboxed consistently so the composite aligns pixel-perfect. Establish one canonical canvas size early.
- Free trial credits exist on new Decart accounts — use for MVP testing before spending.

## 8. Reference links (verify current docs at build time)

- MediaPipe Hand Landmarker (Web/JS): https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- Decart platform & SDK docs: https://docs.platform.decart.ai/models/realtime/lucy-2.5 and https://platform.decart.ai/
- Decart JS SDK: `@decartai/sdk` on npm

---

## 9. Working agreements for Claude Code

- Build phase by phase; do not start Phase 1 until Phase 0 exit criteria pass.
- Desktop first (§3.1). Build and measure against Chrome on macOS. Never trade desktop quality for mobile compatibility, and do not add mobile-specific code paths unasked.
- Keep the gesture trigger logic behind an interface so alternative trigger strategies can be swapped in.
- Everything client-side; no secrets committed; API key via env/local input only.
- Prefer simple 2D canvas first; optimize only if FPS < 24.
