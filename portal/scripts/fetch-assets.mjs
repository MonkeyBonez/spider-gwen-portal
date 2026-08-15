/**
 * Populates public/wasm and public/models.
 *
 * These are ~20MB of binaries, so they are gitignored and fetched instead:
 *  - the MediaPipe WASM runtime is copied out of node_modules (version-matched)
 *  - hand_landmarker.task (float16) is downloaded from Google's model CDN
 *
 * Serving both locally rather than from a CDN keeps startup fast and offline-safe.
 * Idempotent — runs on postinstall and before dev/build.
 */

import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WASM_SRC = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const WASM_DEST = resolve(root, 'public/wasm');
const MODEL_DEST = resolve(root, 'public/models/hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

async function exists(path) {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(WASM_SRC))) {
    console.error('[assets] @mediapipe/tasks-vision not installed — run npm install first.');
    process.exit(1);
  }
  await mkdir(WASM_DEST, { recursive: true });
  await cp(WASM_SRC, WASM_DEST, { recursive: true });
  console.log('[assets] MediaPipe WASM runtime copied to public/wasm');

  if (await exists(MODEL_DEST)) {
    console.log('[assets] hand_landmarker.task already present');
    return;
  }
  await mkdir(dirname(MODEL_DEST), { recursive: true });
  console.log('[assets] downloading hand_landmarker.task …');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status} ${res.statusText}`);
  await writeFile(MODEL_DEST, Buffer.from(await res.arrayBuffer()));
  console.log('[assets] hand_landmarker.task downloaded');
}

main().catch((err) => {
  console.error('[assets]', err.message);
  process.exit(1);
});
