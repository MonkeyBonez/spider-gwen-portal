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
- `gap` = mean distance between (L-index, R-index) and (L-thumb, R-thumb), normalized by hand size (e.g. wrist-to-middle-MCP distance) so it's camera-distance invariant.
- `area` = polygon area, similarly normalized.
- Velocity of `gap` (moving together vs. apart).

Proposed logic v1 (Sne's idea):
- When fingertips are moving together AND `gap` drops below a "touching" threshold → mark `CLOSED` (set a flag).
- When fingertips start moving apart from `CLOSED` → **advance to the next prompt** at the moment of opening.
- Debounce: require `CLOSED` to hold for N frames (start N=3) before it can trigger; cooldown of ~500ms between switches to prevent rapid-fire flapping.

Design intent: the prompt swap should happen while the portal is closed/near-closed so the transition frames of the AI model are hidden behind the closed hands. Lucy 2.5 supports changing the prompt mid-stream on a live connection (`setPrompt` / `realtimeClient.set({prompt})`) with near-instant adaptation — so we fire `setPrompt` on the CLOSED flag, and by the time hands open, the new dimension has settled.

**Thresholds are guesses. Build a debug panel** (see §5) to tune them live.

### 2.3 Sync / latency alignment

- Lucy realtime is marketed at sub-40ms inference latency at 30fps over WebRTC; real end-to-end latency = inference + network RTT, and will vary. Treat total delay as an unknown to measure, not a constant.
- The portal mask is computed locally (~1 frame). The Lucy stream arrives delayed. If we composite naively, the transformed self lags the mask.
- **Approach, in order:**
  1. **V1: composite live, no compensation.** May look fine at small delays. Ship this first and evaluate visually.
  2. **V2: delay the raw feed + mask by an estimated Δ** to align with Lucy's stream. Implement a ring buffer of (frame, landmarks, timestamp) and render from `now − Δ`. Δ is a user-tunable slider in the debug panel (0–500ms). Investigate whether the Decart SDK exposes latency/stats (WebRTC `getStats()` RTT is a fallback estimator).
  3. Note: delaying the *entire displayed output* by Δ is acceptable — the user is performing to camera, a uniform ~100ms display delay is not noticeable in the recording.

---

## 3. Tech stack

- **Frontend:** Single-page web app. React + Vite (or plain TS if simpler). No backend required for POC/MVP — everything runs client-side except Lucy's cloud inference.
- **Hand tracking:** `@mediapipe/tasks-vision` npm package → `HandLandmarker`, `runningMode: "VIDEO"`, `numHands: 2`, GPU delegate (WASM/WebGL). Model asset: the official `hand_landmarker.task` float16 bundle from Google's storage CDN. (Do NOT use the legacy TensorFlow.js handpose or legacy MediaPipe Hands solution — use the current Tasks API.)
- **AI video:** `@decartai/sdk` → `client.realtime.connect(stream, { model: models.realtime("lucy-2.5"), ... })`. WebRTC-based; returns a transformed MediaStream via `onRemoteStream`. Prompt changes mid-session via `realtimeClient.setPrompt(...)` (await server ack). Output is 720p; request camera at the model's specified width/height/fps.
  - Model choice: default **lucy-2.5** (general realtime editing, best prompt-following). **lucy-restyle-2** is a fallback/alternative to A/B for full-scene restyling. Check current model IDs in Decart docs at build time.
- **Compositing:** `<canvas>` (2D context is likely sufficient; WebGL if perf demands). Per displayed frame: draw raw video → set clip path to portal polygon (even-odd) → draw Lucy video inside clip. Feathered edge via shadow/blur trick or offscreen mask canvas.
- **Recording (MVP 1.5):** `canvas.captureStream(30)` → `MediaRecorder` → webm (mp4 via muxer lib if needed for social apps). Include mic audio track optionally.

---

## 4. Phased plan

### Phase 0 — POC (no Lucy, no cost)
Goal: prove hand tracking, polygon geometry, and the gesture state machine end-to-end.
- Webcam feed + MediaPipe Hand Landmarker.
- Draw the portal polygon filled with a **solid color** (green-screen stand-in).
- Gesture state machine: each close→open cycle switches the fill color (white → red → blue → ...). This is a 1:1 stand-in for prompt switching.
- Debug panel with live thresholds, landmark visualization toggle, FPS counter, state readout.
- **Exit criteria:** rectangle and bowtie cases render correctly; color reliably switches exactly once per close→open cycle across ~20 consecutive cycles; ≥24 fps on a laptop.

### Phase 1 — MVP (Lucy integration)
Goal: replace solid color with live Lucy stream.
- Connect one persistent Lucy realtime session when the user hits "Start" (single stream — do NOT run parallel streams; `setPrompt` replaces the need for pre-warmed backup streams).
- Prompt library of ~6 Spider-Verse dimension prompts (see §6); cycle via `setPrompt` on CLOSED.
- Composite per §2. V1 sync (no compensation), then V2 delay buffer if needed.
- Disconnect Lucy on Stop/idle timeout (billing is per generation-second — never leave a stream running).
- **Exit criteria:** full trend effect works live; prompt visibly changes each cycle; transition artifacts hidden by closed hands.

### Phase 1.5 — Recording & export
- Record button → MediaRecorder on the composited canvas (+ mic).
- Download file; countdown timer; basic UX polish (start screen, camera permission flow, mobile browser check).
- **Performer HUD — hand skeleton as a dimension indicator** (Sne's idea, see §4.1).
- **Exit criteria:** exported file contains the composite only — no skeleton, no HUD, no debug overlay.

#### 4.1 Performer HUD: skeleton dimension indicator

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

### Phase 2 — BYO key & cost model
- User pastes their own Decart API key (stored in localStorage only, never sent to any server of ours). Their usage bills to their account.
- Later option: hosted accounts where users pay us and we pay Decart — requires backend, auth, metering. Out of scope for now; note only.
- Cost hygiene: idle detection (no hands detected for 20s → pause/disconnect Lucy), session timer visible to user, estimated cost readout if Decart exposes usage ticks (the SDK exposes `generationTicks`).

---

## 5. Debug panel (build in Phase 0, keep behind a flag)

- Landmark overlay on/off; portal polygon outline on/off. (In Phase 1.5 this overlay grows into the performer-facing skeleton indicator — see §4.1 — so build it as one component, not two.)
- Sliders: EMA α, close threshold, open threshold, debounce frames, cooldown ms, sync delay Δ.
- Readouts: FPS, state machine state, normalized gap/area, Lucy connection state, generation seconds used.

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
- **Lucy latency variance** on real networks; the Δ-buffer is the mitigation.
- **Hands inside Lucy's output:** Lucy transforms the whole frame including hands — this is fine (inside the portal you *want* transformed hands), but check edge seams where transformed hands meet real hands at the polygon boundary; feathering should help.
- **Mobile browser support:** MediaPipe tasks-vision + WebRTC both work on modern mobile browsers but perf-test early on iOS Safari (Sne is on iOS).
- **Resolution mismatch:** Lucy outputs 720p at a fixed aspect; camera/canvas must match or be letterboxed consistently so the composite aligns pixel-perfect. Establish one canonical canvas size early.
- Free trial credits exist on new Decart accounts — use for MVP testing before spending.

## 8. Reference links (verify current docs at build time)

- MediaPipe Hand Landmarker (Web/JS): https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- Decart platform & SDK docs: https://docs.platform.decart.ai/models/realtime/lucy-2.5 and https://platform.decart.ai/
- Decart JS SDK: `@decartai/sdk` on npm

---

## 9. Working agreements for Claude Code

- Build phase by phase; do not start Phase 1 until Phase 0 exit criteria pass.
- Keep the gesture trigger logic behind an interface so alternative trigger strategies can be swapped in.
- Everything client-side; no secrets committed; API key via env/local input only.
- Prefer simple 2D canvas first; optimize only if FPS < 24.
