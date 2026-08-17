# Portal — Real-Time Spider-Verse Dimension Portal (PRD + Build Context)

**Status:** **Phase 0 complete** — exit criteria tested and signed off by Sne, 2026-08-16 (`portal/`). **Phase 1 in progress:** Decart API key obtained, and the SDK surface verified directly against `@decartai/sdk@0.1.21` (§2.3.1, §3) — which corrected this document's latency section and raised the expected Δ from ~100ms to 300–600ms (§2.3, §7). This document is the full context for the project. Read it entirely before writing code.
**Owner:** Sne
**Last updated:** 2026-08-16

---

## 1. What we're building and why

There's a viral trend (the "Spider-Gwen trend," sparked by the recent live-action Spider-Man movie riffing on the animated Spider-Verse multiverse) where creators film a selfie video, bring both hands together in front of the camera — thumbs touching, index fingers touching — and open/close their hands like a window. Each time the hands open, the gap between them appears to reveal "another dimension": an AI-generated Spider-Verse version of themselves, mirroring their motion. Each close→open cycle reveals a *new* dimension/variant.

Today, creators do this manually: record video → screenshot frames → generate AI images of themselves → feed into an image-to-video tool (e.g. Higgsfield) → hand-composite the result frame by frame. It's a very high lift.

**Our product collapses that entire workflow into a live browser experience.** Open a website, allow camera access, do the hand gesture, and the portal effect happens in real time — live AI video inside the portal, new dimension on every open. Record and post.

### 1.1 Open question: positioning and visual language

**Status: undecided (Sne, 2026-08-16). Does not block Phase 1.** Recorded here so
it doesn't get decided by accident.

Two directions:

- **A — Creator tool.** "Make the trend video." Friendly, social-native, obvious
  onboarding, a big record button. The app is a utility and says so.
- **B — The device.** The interface is *diegetic*: an instrument for reaching
  another dimension. Readouts read as telemetry from the portal rather than as a
  developer's debug panel. The app is a prop that happens to actually work.

**The fact that decides more than it looks like it should: the UI is never in the
recording.** §4.2 makes that a hard architectural constraint — the exported file
contains the composite and nothing else. So the visual language is invisible to
the *trend's* audience. It only ever reaches the creator, plus whatever we put on
a landing page.

That cuts in a specific direction. Branding can't ride along inside the shared
artifact, so it can only pay off through **how using it feels** — which is
exactly what makes someone tell a friend. "It felt like operating a real
interdimensional device" travels; "it was a competent utility" does not.

Constraints on B, if we go that way:

- **Diegetic skin, utility bones.** The primary path — permission → frame your
  hands → rehearse → record → download — has to stay dead obvious. Style the
  instrumentation, never the exit. An aesthetic that taxes the task is a failure
  however good it looks.
- **The numbers get easier, not harder.** Latency, generation seconds and switch
  counts read as natural telemetry in B, where in A they are alarming clutter
  ("why is this showing me milliseconds?"). The honest cost display we need for
  a BYO-key product (Phase 2) is *easier* to justify under B.
- **"High-tech" today is an accident, not a choice.** The current look is a debug
  panel, which resembles B only because instrument panels and developer panels
  share ancestry. There is a real difference between *instrument* and
  *unfinished*, and keeping the debug aesthetic by default lands on the wrong
  side of it. Choosing B means designing it, not inheriting it.

**What forces the call:** §4.3, the gesture tutorial, is the first screen a
first-time user meets, and it can't be built in a placeholder visual language.
Note that its structure already leans B without trying — "show us your hands in
position 1, then position 2" is calibration framing, which is simultaneously the
most useful thing to say and the most in-world. That convergence is mild evidence
the two directions are less opposed here than they usually are.

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

##### How the two sides combine: worst-side bias

The mode above picks *which* two distances to measure. This is the separate question
of how those two collapse into one `gap`, and the original answer — a plain mean —
has its own bug (Sne, from live testing): **a wide side gets cancelled out by a tight
one, so the close fires too early.**

Worked: index fingers 0.60 hand-widths apart with the thumbs touching gives
`(0.60 + 0.00) / 2 = 0.30`, under the 0.35 close threshold. The portal is plainly an
open triangle and the machine latches CLOSED. This is a different failure from the
hinge above, which is extreme enough that even the mean reads open; this one lives in
the moderate middle, where one side is merely *fairly* wide.

The requirement: **when one side is long, the other must be much smaller before the
close counts.** Implemented as a single tunable, `worstSideBias` ∈ [0, 1]:

```
gap = mean + bias * (max − mean)
```

| bias | Behaviour |
| --- | --- |
| 0 | the plain mean — the old behaviour, kept as the control case |
| 1 | exactly `max`, algebraically. Closed means *both* sides are closed; a long side vetoes the close outright |
| between | a long side forces the short one much smaller. At 0.7 a side at 0.4 can still close if the other is near zero; a side at 0.5 cannot close at all |

Two properties worth relying on:

- **Symmetric poses read identically at every bias.** When both sides agree, the mean
  and the max are the same number. So the fully-open and fully-shut readings don't
  move, and unlike a contact-mode change **this needs no threshold retuning**. The
  four-points-converging-together case — the one that already worked — is provably
  untouched.
- **The bias applies within a pairing, not across pairings.** `paired` still takes the
  `min` of the parallel and crossed pairings; the blend just combines the two sides
  inside each. `any` is unaffected, having no notion of two sides.

**The value is deferred**, like the transition variant in §4.1, and picked by feel
rather than argued about. Two harnesses:

- **`/tune.html`** — the live one, and where the decision actually gets made. Five
  independent copies of the real trigger run in parallel, one per bias, all fed the
  same camera frames, each keeping its own switch count. Perform ten deliberate cycles
  and then the sloppy lopsided close, and the counts say which bias matched intent. A
  scatter of where real hands land in side-vs-side space, overlaid with the shaded
  closed region, turns tuning into "cover the closes I meant, miss the ones I didn't".
  It writes to the app's own settings, so the chosen value is live immediately.
- **`/closure.html`** — the same comparison on a synthetic pose you drag, with the
  decision boundary drawn. No camera needed; good for understanding the rule.

Provisional default 0.7.

### 2.3 Sync / latency alignment

- **Δ is much larger than the marketing number.** Lucy realtime is marketed at sub-40ms inference at 30fps, but the SDK's own quality bands (verified in the shipped code, §2.3.1) rate glass-to-glass **≤500ms as "good", ≤900ms "fair", ≤1500ms "poor"**, with a source comment citing a server-side pipeline median of ~285ms. So plan for Δ in the **300–600ms** range, not ~100ms, and treat the marketed figure as inference alone on Decart's own hardware. Measure before designing around any number.
- The portal mask is computed locally (~1 frame). The Lucy stream arrives delayed. If we composite naively, the transformed self lags the mask.
- **Approach, in order:**
  1. **V1: composite live, no compensation.** May look fine at small delays. Ship this first and evaluate visually.
  2. **V2: delay the raw feed + mask by an estimated Δ** to align with Lucy's stream. Implement a ring buffer of (frame, landmarks, timestamp) and render from `now − Δ`. Δ is a user-tunable slider in the debug panel (0–500ms). Investigate whether the Decart SDK exposes latency/stats (WebRTC `getStats()` RTT is a fallback estimator).
     - **Where the estimate comes from: the SDK, not us.** See §2.3.1.
  3. ~~Note: delaying the *entire displayed output* by Δ is acceptable — the user is performing to camera, a uniform ~100ms display delay is not noticeable in the recording.~~ **This assumption does not survive a Δ of 300–600ms.** It is true that the *recording* is unharmed — every frame is internally consistent, and nobody watching it can tell when it was captured. What breaks is the **monitor**: the performer sees their own hands up to half a second late, which is well past the point where hand–eye feedback stops working. Framing a portal to a delayed preview is like singing with headphone delay.
  4. **So the two options are both worse than this section assumed, and the choice is now a real one:**
     - **V1 (composite live)** keeps the monitor honest, and pays at the *seam*: the portal polygon tracks the live fingertips while the pixels inside it are Δ old, so transformed hands inside the frame sit half a second behind the real hands bordering it. How bad that looks is an empirical question — feathering helps, and "the other universe runs slightly behind ours" is not an unreasonable thing for a portal to do.
     - **V2 (delay everything by Δ)** makes the seam perfect and the monitor laggy.
     - A possible third path if V1's seam is the problem: keep the *preview* live and un-delayed for the performer, and apply the Δ alignment only to the **recorded** canvas, which nobody has to perform against. Costs a second composite; noted, not designed.
     - **Do not pick from the armchair.** Measure `g2gMs` in the first session (it is free — see §2.3.1), then look at V1 on camera. This is the first thing Phase 1 should answer.

#### 2.3.1 Measuring Δ — use the SDK's glass-to-glass number

**Verified against the shipped JS SDK, `@decartai/sdk@0.1.21`, on 2026-08-16** — types in
`dist/**/*.d.ts`, implementation in `dist/**/*.js`, plus its README. This section previously
described the *Android* SDK's approach second-hand and got three things wrong; those are called
out below so the corrections don't get quietly reverted by someone reading the old Android docs.

- **`g2gMs` exists in the JS SDK and is exactly Δ** — steady-state camera→display latency
  *including inference*. Alongside it: `ttffMs` (startup, connect → first rendered frame),
  `medianMs` / `p90Ms`, `sampleCount`, and `dropRatio`.
- **Correction 1 — it is not a pixel watermark.** The mechanism is **LiveKit frame metadata**: a
  capture timestamp rides along as a packet trailer, the server propagates it through inference,
  and the SDK matches it against playout. The README states plainly that it *does not alter
  visible pixels*. The old worry — a marker showing up in the user's recording, and a marker
  having to survive Lucy's transformation — does not apply. Nothing to hide, nothing to disable.
- **Correction 2 — `debugQuality` is not the switch. Do not use it.** The option is accepted by
  the connect-options schema (`realtime/client.js`) and then **read nowhere else in the package**.
  It is inert. Building a "measure latency" toggle around it would have produced a control that
  silently did nothing.
- **Correction 3 — measurement is on by default, and free.** It is gated on browser capability,
  not on any flag: `isFrameMetadataRuntimeSupported()` requires WebRTC encoded transform —
  `RTCRtpScriptTransform` (the non-Chromium path) or `RTCRtpSender/Receiver.prototype.createEncodedStreams`.
  **Chrome on macOS has the latter, Safari has the former, so both §3.1 P0 and P1 targets are
  covered.** Unsupported runtimes just report `null` and fall back to RTT; nothing breaks.
- **Read it from the `stats` event, not from `onConnectionQuality`.** This is the trap in the API:
  `onConnectionQuality` and the `connectionQuality` event are **debounced — they only re-fire when
  the verdict changes**, so a HUD driven off them shows a stale number indefinitely while the
  connection holds steady. The continuous feed is the `stats` event, ~1/s:
  ```ts
  realtimeClient.on('stats', ({ glassToGlass }) => {
    setDelta(glassToGlass?.medianMs);        // Δ
    setTtff(glassToGlass?.ttffMs);           // one-shot startup figure
  });
  ```
  `realtimeClient.getConnectionQuality()?.metrics.g2gMs` is the pull-based equivalent if a poll
  suits the call site better.
- **`g2gDropRatio` is not usable yet.** Documented, typed, and hardcoded to stay `null` until
  Decart propagates frame *identity* (not just timestamps) through the server pipeline. Latency
  works; drop ratio does not. Do not put it on the panel.
- **What "good" means, per the SDK's own thresholds:** g2g good ≤500ms / fair ≤900ms / poor
  ≤1500ms; TTFF good ≤4s / fair ≤6s / poor ≤10s. Those bands are the basis for the revised Δ
  estimate in §2.3 — a **4–5 second cold start is considered normal**, which the Start-button UX
  has to cover with something to look at.
- **Frame metadata is flagged experimental in LiveKit.** It could regress on an SDK bump. Δ
  degrading to "RTT plus a guess" is survivable, but pin the SDK version and re-check `g2gMs` is
  non-null after any upgrade.
- **`requestVideoFrameCallback` cannot replace it.** rvfc does expose `captureTime` and
  `receiveTime` for WebRTC sources, but for Lucy's stream "capture" means *when Decart's server
  emitted the frame*, not when our camera saw the original. So rvfc measures the downlink leg
  only. Useful for splitting Δ into network-down vs. everything-else when debugging; not a
  substitute for `g2gMs`. These fields are also optional per spec and Chromium-implemented.
- **The manual slider stays regardless.** A measured Δ is a starting value, not a lock.
  Measured-once vs. re-measured periodically vs. a fixed value picked by feel vs. no compensation
  at all (V1) are all live options to A/B.

**Preflight, before a session exists.** `client.realtime.checkConnectivity()` is a **free**
network-only reachability check (a throwaway peer connection against public STUN; reports
`transport: "udp" | "relay" | "failed"` and `rttMs`) — cheap enough to run behind the Start
button and refuse gracefully on `"critical"`. Its `{ deep: true, model }` form opens a real
short session with a synthetic source to measure actual `g2gMs`/`ttffMs` before committing —
**that one costs GPU seconds**, so it is a debug-panel action, never something that runs on load.

**Backburner — `onConnectionQuality`.** Still the right input for a "your connection is degrading"
UI state, and `limitingFactor` (`bandwidth` / `latency` / `loss` / `stall` / `cpu` / `none`) is
genuinely useful for telling a user *why*. Its debouncing, which makes it wrong for a Δ readout,
is exactly right here. Note `availableUpstreamKbps` is Chromium-only, so the bandwidth dimension
goes quiet on Safari. Separate from Δ and not needed to ship — note it, do not build it yet.

**Cut:** deriving Δ ourselves by cross-correlating motion energy between the outgoing and returned streams. It was designed to solve a problem the SDK already solves, and its only remaining value would be validating `g2gMs`. Not worth the build.

---

## 3. Tech stack

- **Frontend:** Single-page web app. React + Vite (or plain TS if simpler). No backend required for POC/MVP — everything runs client-side except Lucy's cloud inference.
- **Hand tracking:** `@mediapipe/tasks-vision` npm package → `HandLandmarker`, `runningMode: "VIDEO"`, `numHands: 2`, GPU delegate (WASM/WebGL). Model asset: the official `hand_landmarker.task` float16 bundle from Google's storage CDN. (Do NOT use the legacy TensorFlow.js handpose or legacy MediaPipe Hands solution — use the current Tasks API.)
- **AI video:** `@decartai/sdk` (pinned at **0.1.21**, surface verified 2026-08-16) → `client.realtime.connect(stream, { model: models.realtime("lucy-2.5"), onRemoteStream, ... })`. WebRTC over LiveKit; returns a transformed MediaStream via `onRemoteStream`. Prompt changes mid-session via `await realtimeClient.setPrompt(text, { enhance })` — it returns a Promise, so the ack is awaitable.
  - Model choice: default **lucy-2.5**, which the SDK defines as **1280×720 @ 30fps** — an exact match for our canonical canvas (§7), so no letterboxing. **`lucy-restyle-2` is 1280×704**, so switching to it as an A/B is *not* free: it changes the aspect and breaks pixel alignment. Budget for that if it gets tried.
  - `initialState.prompt` sets dimension #1 **at connect time**, so the first frames never arrive in the wrong universe. Use it rather than firing `setPrompt` immediately after connecting.
  - **Connect options worth knowing:** `resolution: "720p" | "1080p"`, `preferredVideoCodec` (the SDK already forces vp8 on desktop Safari by itself), and `mirror` — which **defaults to `false`, and must stay that way**: we mirror in the canvas, so letting the SDK mirror too would flip the portal contents against the mask.
  - **Cost metering comes free:** the `generationTick` event carries `{ seconds }` and `generationEnded` carries `{ seconds, reason }`. That is the §5 "generation seconds used" readout and the Phase 2 cost model, with no polling. (Earlier drafts called this `generationTicks` — wrong name.)
  - **There may be a queue.** `onQueuePosition` / the `queuePosition` event report `{ position, queueSize }`, and `ConnectionState` includes `"connecting" | "connected" | "generating" | "disconnected" | "reconnecting"`. The Start flow needs to show queue position and a ~4–5s cold start (§2.3.1), not a dead button.
  - **Key handling, as shipped by the SDK:** `createDecartClient({ apiKey })` for local dev; `createDecartClient({ proxy })` for a keyless client that talks to a backend of ours; and `client.tokens.create(...)` mints **ephemeral keys** (`expiresIn` 1–3600s, plus `allowedModels`, `allowedOrigins`, and a `maxSessionDuration` constraint). The ephemeral-token path is the right answer for Phase 2 if we ever host this — it needs a backend to hold the real key, which is exactly the boundary §Phase 2 already draws.
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
- **Exit criteria — PASSED, tested by Sne 2026-08-16:** rectangle and bowtie cases render correctly; color reliably switches exactly once per close→open cycle across ~20 consecutive cycles; ≥24 fps in Chrome on the macOS dev laptop (the P0 target, §3.1).
- Settled during Phase 0, beyond the original scope: close detection on **all four points converging** (§2.2.1), and the **`iris`** transition driven **`gestural`ly** (§4.1).

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

**Settled: the two halves are driven by the gesture, not by a clock** (Sne). The
transition is two independently triggered steps rather than one timed sequence:

| | `timed` | **`gestural`** (default) |
| --- | --- | --- |
| collapse starts | when the switch fires | when the four points come together (§2.2.1) |
| how long it stays shut | `holdMs`, a fixed number | **as long as the hands stay together** |
| reopen starts | when the timer expires | **when the hands have moved apart past `releaseThreshold`** |

**The bloom point is its own threshold.** `releaseThreshold` (default 0.6) is
deliberately *above* `closeThreshold` (0.5), so the portal stays collapsed past the
point where a close stops counting: the hands get a head start and the portal catches
up. That lag is the effect — see "the variable that actually matters" below. Three
distinct numbers, easily confused:

| Threshold | What it does |
| --- | --- |
| `closeThreshold` | how near counts as shut — fires the collapse **and the switch** |
| `releaseThreshold` | where the reopen animation begins. Clamped up to `closeThreshold`; above `openThreshold` it has no further effect, since the fast-open catch fires there regardless |
| `openThreshold` | re-arms the trigger for the next cycle. **Does not drive the animation** — the bloom is already underway by then |

Why this is the better model: a fixed hold cannot know what the hands are doing, so it
either reopens *behind still-closed hands* — the portal blooms into a dimension the
viewer can't see yet — or lags a fast cycle. Under `gestural` the portal is shut for
exactly the span the performer holds it shut, and the bloom into the next dimension is
the reveal, synchronised to the hands opening by construction. `holdMs` becomes dead
weight. `timed` stays selectable as the control.

**The hold has no time limit, deliberately.** An early build capped it at 2s via
`maxHoldMs`, which reopened the portal while the hands were still visibly closed —
holding the gesture is a performance choice, not a fault, and a clock cannot tell the
two apart. That cap now defaults to **off**. The failure it was meant to catch is
*losing* the hands, so that is what triggers the bail-out now: when tracking drops for
`lostResetMs` the state machine falls to IDLE and the app releases the portal on that
signal. Rule of thumb for anything similar: bail out on the actual failure condition,
never on elapsed time that a legitimate performance can also reach.

Note what this does to §7's open question about Lucy's settle time: under `gestural`
the hold is however long the performer holds, so a slow `setPrompt` is absorbed by the
gesture itself rather than needing a longer configured hold. Worth re-checking in
Phase 1 — if Lucy is slower than a natural close, we still need a floor.

**The variable that actually matters** is not which shape it collapses to, but how the
transition's duration compares to the hand motion underneath it. Hands open in roughly
150–250ms. A reopen tween of about that length is invisible — the portal just tracks
the fingers as it always did. The effect only reads if the portal is *decoupled*:
noticeably slower than the hands (the portal lags, then catches up) or snappier
(the portal is already open before the hands are). Tune duration first, pick the shape
second.

**Settled: `iris`.** A wider set was prototyped (an eyelid drop and a sideways wipe);
those are cut. Of the shortlist, **Sne picked `iris`** — the portal shrinks to a point
and blooms back, which reads as a lens or an aperture rather than as hands. The others
stay selectable as controls, not as open questions:

| Variant | Collapses to | Reads as |
| --- | --- | --- |
| **`iris`** | **a point at the centre** | **camera shutter / lens. The chosen default.** |
| `shutter` | a vertical slit on the midline | the hands themselves closing — physically congruent, but reads as a wipe |
| `twist` | a point, while rotating | a wormhole spinning shut |
| `none` | — | not a fourth variant — the off switch, kept as the control case |

Timing and overshoot are sliders, not variants — a hard collapse with a slow bloom and
a strong overshoot is a very different feel from a symmetric ease, using the same shape.

Settled so far: **`iris`**, **`gestural`**. Still open:

- Does the transition survive being filmed, or does it read as a glitch? The control
  case (`none`) exists to answer this honestly — it is possible the cleanest result is
  no animation at all, with the hands doing the masking as originally planned. This is
  a question for a real take with Lucy behind it, not a flat colour.
- Collapse and reopen durations. `iris` and `gestural` fix the *shape* and the
  *triggering*; `collapseMs` and `reopenMs` are still guesses.
- Should the reopen track the live fingertips (current behaviour) or reopen to the
  fingertip positions *captured at collapse*? The former keeps the portal glued to the
  hands; the latter would let the portal open somewhere the hands no longer are, which
  might look broken or might look great.
- A slice/glitch-shatter transition — the portal breaking into offset bands before
  reassembling — is the most on-trend option for this aesthetic, but it needs a
  different geometry representation than the 4-point polygon. Deferred, not dismissed.

### Phase 1 — MVP (Lucy integration)
Goal: replace solid color with live Lucy stream.
- **First task, before any UI work: connect once and read `g2gMs`.** Everything downstream — whether the delay buffer gets built at all, and which of the §2.3 options we take — turns on that number, and it takes one session to get. Log it, write it down here.
- Connect one persistent Lucy realtime session when the user hits "Start" (single stream — do NOT run parallel streams; `setPrompt` replaces the need for pre-warmed backup streams). Cover the ~4–5s cold start and any queue position with real UI (§3), not a frozen button.
- Prompt library of ~6 Spider-Verse dimension prompts (see §6); cycle via `setPrompt` on CLOSED.
- Composite per §2. V1 sync (no compensation), then V2 delay buffer if needed.
- Disconnect Lucy on Stop/idle timeout (billing is per generation-second — never leave a stream running).
- **Exit criteria:** full trend effect works live; prompt visibly changes each cycle; transition artifacts hidden by closed hands.

### Phase 1.5 — Recording & export
- Record button → MediaRecorder on the composited canvas (+ mic).
- Download file; countdown timer; basic UX polish (start screen, camera permission flow). Verify export works in Safari on macOS, not just Chrome — codec support differs. An unsupported-browser notice is enough for anything outside the §3.1 tiers; no mobile-specific work here.
- **Performer HUD — hand skeleton as a dimension indicator** (Sne's idea, see §4.2).
- **Gesture tutorial** — confirm hands are in frame, teach the gesture as two held positions, and fit the close/open thresholds to this user's actual hands (Sne's idea, see §4.3). Needs no Lucy connection.
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

#### 4.3 Onboarding: the gesture tutorial

Before the first real take, walk the user through the gesture once.

**Scope note.** An earlier draft of this section also used the tutorial to *measure
end-to-end latency*, by cueing a move between two poses and hunting for that move in
the returned stream. That is cut: the Decart SDK reports glass-to-glass latency
directly (see §2.3), so building a vision-based estimator would be reinventing a
number we are already handed. What remains here is a **user-facing tutorial** that
happens to also fit the gesture thresholds, which needs no model and no network.

**This screen forces the positioning call in §1.1** — it is the first thing a
first-time user sees, so it cannot be built in a placeholder visual language.
Decide A vs B before designing it, not during.

**The flow, in order.** Structure it as **two named, held positions** rather than
"do the gesture a few times" (Sne's idea) — it is a two-part shape, so teaching it as
two shapes is clearer than demonstrating a motion, and holding each one gives us a
clean sample of it.

1. **Show your hands.** Nothing starts until both hands are detected. Draw an
   alignment guide on the preview — a ghost outline of the portal shape at a
   comfortable size and position — and ask the user to line their hands up with it.
   Advance when both hands are tracked, roughly on the guide, and stable for ~1s.
2. **Position 1 — portal open.** The wide pose: thumbs and index fingers apart,
   framing an open window. Hold ~1s while we confirm the shape is stable.
3. **Position 2 — portal closed.** Thumbs together, index fingers together. **This
   pose is the start of the close, so position 2 *is* the trigger pose** — the tutorial
   is not a mime of the gesture, it is the gesture. Hold ~1s.
4. **Rehearse the full cycle.** Now open and close ~3 times freely. Confirm each one
   visibly (the switch counter ticks, the skeleton recolours per §4.2, the transition
   plays). This is where the user learns what a registered switch looks and feels like,
   which is what stops them performing a whole take unaware that nothing is firing.
5. **Then start.** Only now offer Record.

Present it as one continuous instruction ("open… and close… good, now do that a few
times") so it reads as a single ~10-second onboarding, not a test.

**What the two held positions buy us, beyond teaching.** Position 1 gives this user's
real open `gap`; position 2 gives their real closed `gap` — with their hands, their
camera distance, their contact mode, held still enough to average over. Fit
`closeThreshold` and `openThreshold` to that measured range instead of shipping the
global guesses in §2.2. Everyone's hands are a different size and everyone sits a
different distance from the laptop; this removes the single most likely cause of "it
doesn't work for me." **This works from Phase 0 — no Lucy, no network, no cost.**

The rehearsal cycles are also the best framerate sample we get, since they run the
full pipeline with the user actually moving. If we are below the §4 Phase 0 bar there,
say so before they record rather than after.

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
- **Run the whole tutorial pre-connect.** Nothing in it needs Lucy now that latency
  measurement is gone, so connect only when the user hits Record. Do not hold an open
  billed stream through an explanatory screen (§2 Phase 2 cost hygiene).
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
- Sliders: EMA α, worst-side bias (§2.2.1), close threshold, release threshold, open threshold, debounce frames, cooldown ms, sync delay Δ, transition collapse/hold/reopen/overshoot/max-hold (§4.1).
- Readouts: FPS, state machine state, normalized gap/area, `gap` under all three contact modes at once, the two side separations behind the current `gap` (`sides a/b` — a lopsided pair is the case the worst-side bias exists to reject), Lucy connection state, generation seconds used.
- Calibration (§4.3): a "run tutorial" button, the measured position-1/position-2 `gap` values, and the thresholds fitted from them. Fitted values must be visibly distinguishable from defaults, and overridable by the sliders above.
- Latency (§2.3.1): a **live** Δ readout fed by the `stats` event — `glassToGlass.medianMs` and `.p90Ms`, with `ttffMs` shown once at connect — alongside the Δ actually in use by the delay buffer, so a drift between measured and applied is visible at a glance. No toggle is needed: measurement is always on and costs nothing. Omit `g2gDropRatio`, which the SDK always reports as `null` today. Later, if built: the debounced `onConnectionQuality` verdict and its `limitingFactor`, and a "deep preflight" button (`checkConnectivity({ deep: true, model })`) — clearly marked, since that one spends GPU seconds.

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
- **Lucy latency variance** on real networks; the Δ-buffer is the mitigation, and the SDK's `g2gMs` (§2.3.1) is how Δ gets a real number. Open: Δ may drift *during* a session, so a one-shot measurement may not be enough — but re-measuring means re-enabling the pixel marker mid-take, which we can't do during a recording. Possible answer is `onConnectionQuality` as a cheap "something changed, Δ is probably stale" signal.
- ~~**`debugQuality` is unverified on the JS SDK.**~~ **Resolved 2026-08-16** by reading `@decartai/sdk@0.1.21` directly. Glass-to-glass measurement is present in the JS SDK, automatic, free, and does not touch visible pixels; `debugQuality` itself is an inert option that must not be built on. See §2.3.1. Two smaller risks replace it: LiveKit frame metadata is **experimental upstream**, so re-check `g2gMs` is non-null after any SDK bump; and it needs WebRTC encoded transform, which Chrome and Safari both have but which would silently degrade to RTT elsewhere.
- **Δ is 3–6× larger than the marketed figure, and that is now the top Phase 1 risk** (§2.3). The SDK's own thresholds treat ≤500ms as good. At that scale, "just delay the display to match" stops being free, because the performer has to frame a portal against a half-second-late preview. Measure `g2gMs` in the very first session and judge V1 on camera before building the delay buffer.
- **Hands inside Lucy's output:** Lucy transforms the whole frame including hands — this is fine (inside the portal you *want* transformed hands), but check edge seams where transformed hands meet real hands at the polygon boundary; feathering should help.
- **Cross-browser desktop support (the risk that actually matters):** Safari on macOS is the one to watch — canvas `filter` (used for the portal feather), `captureStream`, and `MediaRecorder` codec support all differ from Chrome's, and `MediaRecorder` webm output in particular is historically weak there. Test the composite and the Phase 1.5 export in Safari before demoing. Chrome on macOS is the reference implementation.
- **Mobile browser support (P2, non-blocking):** MediaPipe tasks-vision + WebRTC both work on modern mobile browsers in principle, but this is explicitly not a launch requirement (§3.1). Expect the real obstacles to be sustained framerate under thermal throttling and iOS Safari's camera/autoplay quirks. Try it once the desktop path is done; do not let findings here reshape the desktop build.
- **Resolution mismatch:** Lucy outputs 720p at a fixed aspect; camera/canvas must match or be letterboxed consistently so the composite aligns pixel-perfect. Establish one canonical canvas size early.
- Free trial credits exist on new Decart accounts — use for MVP testing before spending.

## 8. Reference links (verify current docs at build time)

- MediaPipe Hand Landmarker (Web/JS): https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- Decart platform & SDK docs: https://docs.platform.decart.ai/models/realtime/lucy-2.5 and https://platform.decart.ai/
- Decart JS SDK: `@decartai/sdk` on npm, installed and pinned at **0.1.21**. The authoritative source is the **installed package itself**, not the Android docs — `node_modules/@decartai/sdk/dist/**/*.d.ts` for the surface, `README.md` for usage, and `dist/realtime/config-realtime.js` for the quality thresholds quoted in §2.3.1. Reading the Android README instead is what put three errors into this document.
- `requestVideoFrameCallback` metadata (`captureTime`, `receiveTime`): W3C spec — note these are optional fields, Chromium-implemented.

---

## 9. Working agreements for Claude Code

- Build phase by phase. Phase 0's exit criteria passed on 2026-08-16, so **Phase 1 is unblocked**; the same rule now applies to Phase 1's own criteria before Phase 1.5.
- Desktop first (§3.1). Build and measure against Chrome on macOS. Never trade desktop quality for mobile compatibility, and do not add mobile-specific code paths unasked.
- Keep the gesture trigger logic behind an interface so alternative trigger strategies can be swapped in.
- Everything client-side; no secrets committed; API key via env/local input only. Concretely: the key lives in `portal/.env.local` (gitignored) for local dev and in localStorage for real use; `portal/.env.example` is the tracked template and must stay key-free. A `.githooks/pre-commit` hook blocks env files and key-shaped strings from being staged — enable it in a fresh clone with `git config core.hooksPath .githooks`. Note that Vite **inlines** `VITE_`-prefixed variables into the bundle, so a deployed build must never carry one.
- Prefer simple 2D canvas first; optimize only if FPS < 24.
