import './style.css';
import { App } from './app';
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
    </div>
    <div class="start" id="start">
      <h1>VerseJumper</h1>
      <p>Open a portal with your hands and jump between Spider-Verse dimensions — live.</p>
      <p class="muted">
        Hold both hands up, thumbs touching and index fingers touching, then open
        and close them. Each close→open cycle switches dimension.
      </p>

      <div class="key-row" id="key-row">
        <label for="key-input">Decart API key</label>
        <input id="key-input" type="password" autocomplete="off" spellcheck="false"
               placeholder="paste key — kept in this browser only" />
        <p class="muted small" id="key-note"></p>
      </div>

      <div class="button-row">
        <button id="start-lucy">Start with Lucy</button>
        <button id="start-couples" class="secondary">Couples edition</button>
        <button id="start-camera" class="secondary">Camera only (free)</button>
      </div>
      <p class="muted small">
        The Lucy stream bills per generation-second. <strong>Couples edition</strong>
        is the same thing with softer worlds — chibi, animated, crayon, watercolour —
        that restyle whoever is in frame instead of putting them in a suit.
        Camera-only runs the whole gesture pipeline with a flat colour in the
        portal and costs nothing.
      </p>
      <p class="muted small">
        Everything is recorded. Press <strong>End &amp; review</strong> to watch
        it back, choose which layers you want, and save the video.
      </p>

      <p class="keys muted">
      D debug panel · L landmarks · E end take &amp; review · Space manual switch<br />
      R reset counters ·
      1–4 pick the switch transition · T flips the timing · C connect/disconnect Lucy
    </p>
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
  [lucyBtn, 'Start with Lucy'],
  [couplesBtn, 'Couples edition'],
  [cameraBtn, 'Camera only (free)'],
];
const errorEl = document.querySelector<HTMLElement>('#error')!;
const keyInput = document.querySelector<HTMLInputElement>('#key-input')!;
const keyNote = document.querySelector<HTMLElement>('#key-note')!;

// A key in .env.local wins, and there is then nothing to type. Showing the
// field anyway would invite pasting a second key that silently loses.
const existing = resolveApiKey();
if (existing.source === 'env') {
  keyInput.remove();
  keyNote.textContent = 'Using VITE_DECART_API_KEY from portal/.env.local.';
} else {
  if (existing.source === 'stored') keyInput.value = existing.key;
  keyNote.textContent =
    'Stored in this browser only (localStorage). Never sent anywhere except Decart.';
}

let instance: App | null = null;

function restoreButtons(): void {
  for (const [btn, label] of LAUNCH_BUTTONS) {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function launch(useLucy: boolean, dimensions?: Dimension[]): Promise<void> {
  for (const [btn] of LAUNCH_BUTTONS) btn.disabled = true;
  errorEl.classList.add('hidden');

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
    },
    {
      useLucy,
      dimensions,
      // Closing the review screen ends the session; put the home screen back
      // exactly as it was, ready to launch again.
      onExit: () => {
        instance = null;
        restoreButtons();
        startScreen.classList.remove('hidden');
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
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.classList.remove('hidden');
    console.error(err);
  }
}

/** Both Lucy-backed buttons need a key first; camera-only never does. */
function launchWithLucy(btn: HTMLButtonElement, dimensions?: Dimension[]): void {
  if (existing.source !== 'env' && !keyInput.value.trim()) {
    errorEl.textContent = 'Paste a Decart API key, or start camera-only.';
    errorEl.classList.remove('hidden');
    keyInput.focus();
    return;
  }
  btn.textContent = 'Starting…';
  void launch(true, dimensions);
}

lucyBtn.addEventListener('click', () => launchWithLucy(lucyBtn));

couplesBtn.addEventListener('click', () => launchWithLucy(couplesBtn, COUPLES_DIMENSIONS));

cameraBtn.addEventListener('click', () => {
  cameraBtn.textContent = 'Starting…';
  void launch(false);
});

// A closed tab must not leave a paid stream running. `pagehide` fires in cases
// `beforeunload` misses (bfcache, mobile), and disconnect is idempotent.
window.addEventListener('pagehide', () => instance?.stop());

if (!navigator.mediaDevices?.getUserMedia) {
  errorEl.textContent =
    'This browser has no camera API. Use a recent Chrome/Safari over https or localhost.';
  errorEl.classList.remove('hidden');
  for (const [btn] of LAUNCH_BUTTONS) btn.disabled = true;
}
