# VerseJumper

Open a portal with your hands and jump between Spider-Verse dimensions — live,
on your own webcam.

<!--
  DEMO GOES HERE.
  Drop a gif or an mp4 in docs/ and link it, e.g.

      ![VerseJumper](docs/demo.gif)

  GitHub plays mp4 if you drag the file into an issue and paste the URL it gives
  you; a gif is the safer bet for autoplay in the README itself.
-->

## What it is

Hold both hands up and frame a rectangle with them — index fingers at the top
corners, thumbs at the bottom. That rectangle becomes a window into another
universe, and it tracks your hands: move them apart and the window stretches,
move them and it follows.

Pinch each hand shut so the two pinches touch, then open again, and you land in
a different dimension. Each close-and-open cycle restyles whatever the camera
can see into a new world.

Under the hood it is three pieces:

- **Hand tracking** — MediaPipe finds 21 landmarks per hand in the browser, and
  four of them (each index tip and thumb tip) become the corners of the portal.
- **A gesture state machine** — decides when the portal counts as shut, with
  debouncing and a cooldown so a twitch is not a dimension jump.
- **A live generative video stream** — [Decart](https://www.decart.ai/)'s Lucy
  restyles your camera feed in real time. The new world is requested the instant
  the portal starts closing, so it has landed by the time the window reopens.

Everything runs in the browser. Nothing is uploaded anywhere except to Decart,
and only while you are streaming.

## What you need

- **Node 20+**
- **A webcam**, and a browser that can use it (recent Chrome or Safari)
- **A Decart API key** — see below

## Get a key

1. Sign up at **[platform.decart.ai](https://platform.decart.ai/)**.
2. Create an API key.
3. New accounts come with free trial credits — those are enough to try this.

## Set your key

Copy the template and paste your key into the copy:

```bash
cd portal
cp .env.example .env.local
```

Then open `portal/.env.local` and fill in the one line:

```
VITE_DECART_API_KEY=your-key-here
```

`.env.local` is gitignored, so your key stays on your machine. It is also read
behind a dev-only guard, which means a production build physically cannot carry
it — the branch and the key are dropped at build time.

If you would rather not put the key in a file, leave it blank and paste the key
into the box on the start screen instead. It is kept in your browser's
localStorage and sent nowhere but Decart.

## Run it

```bash
cd portal
npm install     # also fetches the hand-tracking model and WASM runtime (~20MB)
npm run dev     # then open http://localhost:5173
```

Camera access needs a secure context, which `localhost` counts as. Grant the
camera permission when the browser asks.

The start screen uses the camera straight away — it renders the room as a field
of ASCII characters behind the title, with a web that gathers around whoever is
in frame. That runs entirely in your browser and is never uploaded; the camera
is released the moment a session starts.

Press **Start multiverse-hopping** and a short tutorial will walk you through
the gesture — where to put your hands, and how to jump. It plays while the
stream is warming up, so it costs you nothing but the time you would have spent
waiting anyway.

## What it costs

The Lucy stream **bills per generation-second**, so it is running up a small
tab the whole time it is connected. Two things guard against surprises:

- The session disconnects itself if it stops seeing hands, so walking away does
  not quietly bill you.
- There is a **camera-only mode** that runs the entire gesture pipeline with a
  flat colour in the portal instead of a generated world. It costs nothing and
  is the right way to check your camera, lighting and framing first.

Camera-only and a second prompt set ("couples edition") are tucked away to keep
the start screen simple — **click the VerseJumper title three times** to reveal
them.

## Repo layout

| | |
|---|---|
| `portal/` | the app — Vite, TypeScript, no framework |
| `portal/src/` | source; start at `app.ts` for the render loop |
| `portal/README.md` | developer notes: architecture, tuning pages, test steps |

There are also a few standalone tuning pages under `portal/` — `/tune.html`,
`/tutorial.html`, `/transitions.html` — which run parts of the pipeline in
isolation against the camera, with sliders, and cost nothing to use.

```bash
npm test          # geometry and gesture state-machine unit tests
npm run build     # production build
```
