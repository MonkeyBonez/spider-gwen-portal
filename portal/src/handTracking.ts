/**
 * MediaPipe Hand Landmarker wrapper (PRD §3).
 * Tasks API, VIDEO running mode, 2 hands, GPU delegate, assets served locally.
 */

import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import type { Config } from './config';
import { LM, type HandPoints, type PortalPoints, type Pt, dist } from './geometry';

export interface TrackedHands {
  /** Present only when *both* hands cleared the confidence bar. */
  portal: PortalPoints | null;
  left: HandPoints | null;
  right: HandPoints | null;
  /** Raw landmarks in pixel space, for the debug overlay. */
  rawHands: { label: string; score: number; points: Pt[] }[];
  /** Wall-clock ms spent inside detectForVideo. */
  detectMs: number;
}

const EMPTY: TrackedHands = {
  portal: null,
  left: null,
  right: null,
  rawHands: [],
  detectMs: 0,
};

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;
  private lastResult: TrackedHands = EMPTY;
  private appliedConfidences = '';

  async init(cfg: Config): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(
      `${import.meta.env.BASE_URL}wasm`,
    );
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: cfg.minHandDetectionConfidence,
      minHandPresenceConfidence: cfg.minHandPresenceConfidence,
      minTrackingConfidence: cfg.minTrackingConfidence,
    });
    this.appliedConfidences = confidenceKey(cfg);
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }

  /**
   * Detect on the current video frame. Returns the previous result unchanged if
   * the video has not advanced (rAF can outrun the camera).
   */
  detect(video: HTMLVideoElement, tMs: number, cfg: Config): TrackedHands {
    if (!this.landmarker) return EMPTY;

    // Confidence thresholds are live-tunable; re-apply lazily when they change.
    const key = confidenceKey(cfg);
    if (key !== this.appliedConfidences) {
      this.appliedConfidences = key;
      void this.landmarker.setOptions({
        minHandDetectionConfidence: cfg.minHandDetectionConfidence,
        minHandPresenceConfidence: cfg.minHandPresenceConfidence,
        minTrackingConfidence: cfg.minTrackingConfidence,
      });
    }

    if (video.currentTime === this.lastVideoTime) return this.lastResult;
    this.lastVideoTime = video.currentTime;

    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(video, tMs);
    const detectMs = performance.now() - t0;

    this.lastResult = toTrackedHands(result, video.videoWidth, video.videoHeight, cfg, detectMs);
    return this.lastResult;
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

function confidenceKey(cfg: Config): string {
  return `${cfg.minHandDetectionConfidence}|${cfg.minHandPresenceConfidence}|${cfg.minTrackingConfidence}`;
}

function toPixel(lm: NormalizedLandmark, w: number, h: number): Pt {
  return { x: lm.x * w, y: lm.y * h };
}

function toTrackedHands(
  result: HandLandmarkerResult,
  w: number,
  h: number,
  cfg: Config,
  detectMs: number,
): TrackedHands {
  const rawHands: TrackedHands['rawHands'] = [];
  let left: HandPoints | null = null;
  let right: HandPoints | null = null;

  const handedness = result.handedness ?? result.handednesses;

  for (let i = 0; i < result.landmarks.length; i++) {
    const lms = result.landmarks[i];
    const cat = handedness?.[i]?.[0];
    if (!lms || !cat) continue;

    const points = lms.map((lm) => toPixel(lm, w, h));
    rawHands.push({ label: cat.categoryName, score: cat.score, points });

    // MediaPipe classifies handedness on the *un-mirrored* camera image, which
    // is anatomically correct. `swapHandedness` is the escape hatch if a device
    // hands us a pre-mirrored stream.
    let isLeft = cat.categoryName === 'Left';
    if (cfg.swapHandedness) isLeft = !isLeft;

    const hand: HandPoints = {
      thumb: points[LM.THUMB_TIP],
      index: points[LM.INDEX_TIP],
      size: dist(points[LM.WRIST], points[LM.MIDDLE_MCP]),
      score: cat.score,
    };

    // Keep the higher-scoring candidate if the model labels both hands the same.
    if (isLeft) {
      if (!left || hand.score > left.score) left = hand;
    } else if (!right || hand.score > right.score) {
      right = hand;
    }
  }

  // Only render the portal when both hands are present with sufficient
  // confidence (PRD §2.1).
  const bar = cfg.minHandPresenceConfidence;
  const bothGood = !!left && !!right && left.score >= bar && right.score >= bar;

  const portal: PortalPoints | null =
    bothGood && left && right
      ? {
          lIndex: left.index,
          rIndex: right.index,
          rThumb: right.thumb,
          lThumb: left.thumb,
          handSize: (left.size + right.size) / 2,
        }
      : null;

  return { portal, left, right, rawHands, detectMs };
}
