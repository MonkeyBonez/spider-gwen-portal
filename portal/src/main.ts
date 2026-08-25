import './style.css';
import { App } from './app';
import { AsciiBackdrop } from './asciiBackdrop';
import { COUPLES_DIMENSIONS, type Dimension } from './dimensions';
import { resolveApiKey, storeApiKey } from './lucy';
import { sessionLog } from './sessionLog';

// Under `npm run dev`, every session streams itself to portal/logs/*.ndjson —
// no keypress, nothing to remember, and a crashed or reloaded tab still leaves
// its evidence behind. The endpoint only exists on the dev server (see
// `sessionLogPlugin` in vite.config.ts); `G` remains as a manual export.
if (import.meta.env.DEV) sessionLog.startAutoFlush('/__log');
// Logged unconditionally so every page load leaves a file behind — a session
// that failed before connecting is still evidence, and an empty logs/ then
// means the pipe is broken rather than that nothing happened.
sessionLog.log('app:load', { url: location.pathname });

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <div class="stage-wrap" id="stage-wrap">
      <div class="hud">
        <span class="chip" id="hud-dimension">—</span>
        <span class="chip muted" id="hud-counter">0 switches</span>
        <span class="chip muted hidden" id="hud-lucy">lucy: —</span>
        <span class="chip rec hidden" id="hud-take">● 0:00</span>
        <button class="end-take hidden" id="end-take">End &amp; review</button>
      </div>
      <div class="status hidden" id="status"></div>
      <div class="toast hidden" id="toast"></div>
      <div class="caption hidden" id="caption"></div>
    </div>
    <div class="start" id="start">
      <h1 id="title" title="">Verse<span class="jump">Jumper</span></h1>
      <p>Open a portal with your hands and jump between Spider-Verse dimensions — live.</p>

      <div class="key-row" id="key-row">
        <label for="key-input" id="key-label">Decart API key</label>
        <input id="key-input" type="password" autocomplete="off" spellcheck="false"
               placeholder="paste key — kept in this browser only" />
        <p class="muted small" id="key-note"></p>
      </div>

      <div class="button-row">
        <button id="start-lucy">Start multiverse-hopping</button>
        <button id="start-couples" class="secondary hidden">Couples edition</button>
        <button id="start-camera" class="secondary hidden">Camera only (free)</button>
      </div>
      <p class="error hidden" id="error"></p>
    </div>
  </div>
`;

const startScreen = document.querySelector<HTMLElement>('#start')!;
const lucyBtn = document.querySelector<HTMLButtonElement>('#start-lucy')!;
const cameraBtn = document.querySelector<HTMLButtonElement>('#start-camera')!;
const couplesBtn = document.querySelector<HTMLButtonElement>('#start-couples')!;

/** Every launch button, for the disable-all / restore-all cycle. */
const LAUNCH_BUTTONS: [HTMLButtonElement, string][] = [
  [lucyBtn, 'Start multiverse-hopping'],
  [couplesBtn, 'Couples edition'],
  [cameraBtn, 'Camera only (free)'],
];
const errorEl = document.querySelector<HTMLElement>('#error')!;
const keyInput = document.querySelector<HTMLInputElement>('#key-input')!;
const keyNote = document.querySelector<HTMLElement>('#key-note')!;
const keyLabel = document.querySelector<HTMLElement>('#key-label')!;
const titleEl = document.querySelector<HTMLElement>('#title')!;

// A key in .env.local wins, and there is then nothing to type. Showing the
// field anyway would invite pasting a second key that silently loses.
const existing = resolveApiKey();
if (existing.source === 'env') {
  // Nothing to type, so nothing to label — just say where the key lives, which
  // is the only thing anyone needs to know to change it.
  keyInput.remove();
  keyLabel.remove();
  keyNote.textContent = 'Set DECART API KEY at portal/.env.local';
} else {
  if (existing.source === 'stored') keyInput.value = existing.key;
  keyNote.textContent =
    'Stored in this browser only (localStorage). Never sent anywhere except Decart.';
}

let instance: App | null = null;

/**
 * The start screen watches the room while it waits — the camera as a field of
 * glyphs, with a web knitting itself toward whoever is in frame. It is the
 * app's thesis, running before anything has been pressed.
 *
 * It holds a camera track, so it is stopped for the duration of every session
 * and started again on the way back. `start()` never rejects; a refused camera
 * just leaves the constellation drifting.
 */
const backdrop = new AsciiBackdrop(startScreen);
backdrop.start();

function restoreButtons(): void {
  for (const [btn, label] of LAUNCH_BUTTONS) {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function launch(
  useLucy: boolean,
  dimensions?: Dimension[],
  tutorial = false,
): Promise<void> {
  for (const [btn] of LAUNCH_BUTTONS) btn.disabled = true;
  errorEl.classList.add('hidden');

  // Before `new App(...)`, which opens the camera with its own capture
  // constraints — two live tracks on one device is both wasteful and a way to
  // inherit a resolution nobody asked for.
  backdrop.stop();

  if (useLucy && existing.source !== 'env') storeApiKey(keyInput.value);

  instance = new App(
    document.querySelector<HTMLElement>('#stage-wrap')!,
    {
      status: document.querySelector<HTMLElement>('#status')!,
      dimension: document.querySelector<HTMLElement>('#hud-dimension')!,
      counter: document.querySelector<HTMLElement>('#hud-counter')!,
      toast: document.querySelector<HTMLElement>('#toast')!,
      lucy: document.querySelector<HTMLElement>('#hud-lucy')!,
      take: document.querySelector<HTMLElement>('#hud-take')!,
      endButton: document.querySelector<HTMLButtonElement>('#end-take')!,
      caption: document.querySelector<HTMLElement>('#caption')!,
    },
    {
      useLucy,
      dimensions,
      tutorial,
      // Closing the review screen ends the session; put the home screen back
      // exactly as it was, ready to launch again.
      onExit: () => {
        instance = null;
        restoreButtons();
        startScreen.classList.remove('hidden');
        backdrop.start();
      },
    },
  );

  try {
    await instance.start();
    startScreen.classList.add('hidden');
  } catch (err) {
    instance.stop();
    instance = null;
    restoreButtons();
    // The start screen never went away, so put its backdrop back too.
    backdrop.start();
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.classList.remove('hidden');
    console.error(err);
  }
}

/** Both Lucy-backed buttons need a key first; camera-only never does. */
function launchWithLucy(
  btn: HTMLButtonElement,
  dimensions?: Dimension[],
  tutorial = false,
): void {
  if (existing.source !== 'env' && !keyInput.value.trim()) {
    errorEl.textContent = 'Paste a Decart API key, or start camera-only.';
    errorEl.classList.remove('hidden');
    keyInput.focus();
    return;
  }
  btn.textContent = 'Starting…';
  void launch(true, dimensions, tutorial);
}

lucyBtn.addEventListener('click', () => launchWithLucy(lucyBtn, undefined, true));

/**
 * The other two editions are developer doors, not choices.
 *
 * Offering three buttons made the first-run screen a decision about billing
 * before anyone knew what the thing did. Couples and camera-only still exist —
 * they are how the gesture gets tuned for free — but they are behind three taps
 * on the title, which is enough to keep them out of a stranger's way and easy
 * enough for anyone who has read this far.
 */
let titleTaps = 0;
titleEl.addEventListener('click', () => {
  titleTaps++;
  if (titleTaps < 3) return;
  couplesBtn.classList.remove('hidden');
  cameraBtn.classList.remove('hidden');
});

couplesBtn.addEventListener('click', () => launchWithLucy(couplesBtn, COUPLES_DIMENSIONS));

cameraBtn.addEventListener('click', () => {
  cameraBtn.textContent = 'Starting…';
  void launch(false);
});

// A closed tab must not leave a paid stream running, nor a camera light on.
// `pagehide` fires in cases `beforeunload` misses (bfcache, mobile), and both
// stops are idempotent.
window.addEventListener('pagehide', () => {
  instance?.stop();
  backdrop.stop();
});

if (!navigator.mediaDevices?.getUserMedia) {
  errorEl.textContent =
    'This browser has no camera API. Use a recent Chrome/Safari over https or localhost.';
  errorEl.classList.remove('hidden');
  for (const [btn] of LAUNCH_BUTTONS) btn.disabled = true;
}
