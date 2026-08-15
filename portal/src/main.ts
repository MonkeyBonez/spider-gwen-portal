import './style.css';
import { App } from './app';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <div class="stage-wrap" id="stage-wrap">
      <div class="hud">
        <span class="chip" id="hud-dimension">—</span>
        <span class="chip muted" id="hud-counter">0 switches</span>
      </div>
      <div class="status hidden" id="status"></div>
      <div class="toast hidden" id="toast"></div>
    </div>
    <div class="start" id="start">
      <h1>Portal</h1>
      <p>Phase 0 POC — hand tracking, portal polygon, gesture state machine.</p>
      <p class="muted">
        Hold both hands up, thumbs touching and index fingers touching, then open
        and close them. Each close→open cycle switches the dimension colour.
      </p>
      <button id="start-btn">Enable camera</button>
      <p class="keys muted">
      D debug panel · L landmarks · Space manual switch · R reset counters<br />
      1–4 pick the switch transition (none / iris / shutter / twist)
    </p>
      <p class="error hidden" id="error"></p>
    </div>
  </div>
`;

const startScreen = document.querySelector<HTMLElement>('#start')!;
const startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
const errorEl = document.querySelector<HTMLElement>('#error')!;

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
  errorEl.classList.add('hidden');

  const instance = new App(document.querySelector<HTMLElement>('#stage-wrap')!, {
    status: document.querySelector<HTMLElement>('#status')!,
    dimension: document.querySelector<HTMLElement>('#hud-dimension')!,
    counter: document.querySelector<HTMLElement>('#hud-counter')!,
    toast: document.querySelector<HTMLElement>('#toast')!,
  });

  try {
    await instance.start();
    startScreen.classList.add('hidden');
  } catch (err) {
    instance.stop();
    startBtn.disabled = false;
    startBtn.textContent = 'Enable camera';
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.classList.remove('hidden');
    console.error(err);
  }
});

if (!navigator.mediaDevices?.getUserMedia) {
  errorEl.textContent =
    'This browser has no camera API. Use a recent Chrome/Safari over https or localhost.';
  errorEl.classList.remove('hidden');
  startBtn.disabled = true;
}
