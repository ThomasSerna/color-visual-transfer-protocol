/**
 * Cheap, camera-side temporal quality measurements for COLOR_4.
 *
 * This module deliberately has no DOM or OpenCV dependency. Callers can run it
 * before transferring a full-resolution ImageData buffer to the vision worker.
 */

export const COLOR4_CAPTURE_FINGERPRINT_WIDTH = 64 as const;
export const COLOR4_CAPTURE_FINGERPRINT_HEIGHT = 48 as const;
export const COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE = 8 as const;
export const COLOR4_CAPTURE_FINGERPRINT_LENGTH =
  COLOR4_CAPTURE_FINGERPRINT_WIDTH * COLOR4_CAPTURE_FINGERPRINT_HEIGHT;
export const COLOR4_CAPTURE_FINGERPRINT_BLOCK_COLUMNS =
  COLOR4_CAPTURE_FINGERPRINT_WIDTH / COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE;
export const COLOR4_CAPTURE_FINGERPRINT_BLOCK_ROWS =
  COLOR4_CAPTURE_FINGERPRINT_HEIGHT / COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE;
export const COLOR4_CAPTURE_FINGERPRINT_BLOCK_COUNT =
  COLOR4_CAPTURE_FINGERPRINT_BLOCK_COLUMNS * COLOR4_CAPTURE_FINGERPRINT_BLOCK_ROWS;

const BYTE_MAXIMUM = 255;

export type CaptureStabilityGateMode = "observe" | "enabled";
export type CaptureStabilityState = "warmup" | "stable" | "unstable";

export interface CaptureFingerprintDifference {
  /** Row-major 8x8-block mean absolute errors, each normalized to [0, 1]. */
  readonly blockMaeNormalized: readonly number[];
  /** Nearest-rank 90th percentile of the normalized block MAEs. */
  readonly p90MaeNormalized: number;
}

export interface CaptureStabilityAssessment extends CaptureFingerprintDifference {
  readonly state: Exclude<CaptureStabilityState, "warmup">;
  readonly shouldSubmit: boolean;
}

export interface CaptureStabilityWarmup {
  readonly state: "warmup";
  readonly shouldSubmit: boolean;
}

export type CaptureStabilityResult = CaptureStabilityWarmup | CaptureStabilityAssessment;

function assertDimensions(width: number, height: number, rgbaLength: number): void {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError("Capture width must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("Capture height must be a positive safe integer.");
  }
  const expected = width * height * 4;
  if (!Number.isSafeInteger(expected) || rgbaLength !== expected) {
    throw new RangeError(`RGBA length must be exactly width * height * 4 (${expected}).`);
  }
}

function assertFingerprint(fingerprint: Uint8Array): void {
  if (fingerprint.length !== COLOR4_CAPTURE_FINGERPRINT_LENGTH) {
    throw new RangeError(
      `Capture fingerprints must contain exactly ${COLOR4_CAPTURE_FINGERPRINT_LENGTH} luma samples.`,
    );
  }
}

function assertNormalized(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number in [0, 1].`);
  }
}

/** Convert one sRGB byte triplet to rounded BT.709 luma. Alpha is ignored. */
export function bt709LumaByte(red: number, green: number, blue: number): number {
  return Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
}

/**
 * Create a 64x48 luma fingerprint using the source pixel nearest each target
 * cell's centre. The fixed 3,072-sample cost keeps this suitable for every
 * camera callback, including 1920-wide captures.
 */
export function createCaptureLumaFingerprint(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  assertDimensions(width, height, rgba.length);
  const fingerprint = new Uint8Array(COLOR4_CAPTURE_FINGERPRINT_LENGTH);
  for (let targetY = 0; targetY < COLOR4_CAPTURE_FINGERPRINT_HEIGHT; targetY++) {
    const sourceY = Math.min(
      height - 1,
      Math.floor(((targetY + 0.5) * height) / COLOR4_CAPTURE_FINGERPRINT_HEIGHT),
    );
    for (let targetX = 0; targetX < COLOR4_CAPTURE_FINGERPRINT_WIDTH; targetX++) {
      const sourceX = Math.min(
        width - 1,
        Math.floor(((targetX + 0.5) * width) / COLOR4_CAPTURE_FINGERPRINT_WIDTH),
      );
      const sourceOffset = (sourceY * width + sourceX) * 4;
      const targetOffset = targetY * COLOR4_CAPTURE_FINGERPRINT_WIDTH + targetX;
      fingerprint[targetOffset] = bt709LumaByte(
        rgba[sourceOffset]!,
        rgba[sourceOffset + 1]!,
        rgba[sourceOffset + 2]!,
      );
    }
  }
  return fingerprint;
}

/**
 * Compare two fingerprints by 8x8 blocks. Taking p90 makes the score sensitive
 * to broad display transitions while ignoring motion confined to fewer than
 * roughly ten percent of the blocks.
 */
export function compareCaptureLumaFingerprints(
  previous: Uint8Array,
  current: Uint8Array,
): CaptureFingerprintDifference {
  assertFingerprint(previous);
  assertFingerprint(current);
  const blockMaeNormalized = new Array<number>(COLOR4_CAPTURE_FINGERPRINT_BLOCK_COUNT);
  let blockIndex = 0;
  for (let blockY = 0; blockY < COLOR4_CAPTURE_FINGERPRINT_BLOCK_ROWS; blockY++) {
    for (let blockX = 0; blockX < COLOR4_CAPTURE_FINGERPRINT_BLOCK_COLUMNS; blockX++) {
      let absoluteError = 0;
      const firstY = blockY * COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE;
      const firstX = blockX * COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE;
      for (let offsetY = 0; offsetY < COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE; offsetY++) {
        const rowOffset = (firstY + offsetY) * COLOR4_CAPTURE_FINGERPRINT_WIDTH + firstX;
        for (let offsetX = 0; offsetX < COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE; offsetX++) {
          const index = rowOffset + offsetX;
          absoluteError += Math.abs(current[index]! - previous[index]!);
        }
      }
      blockMaeNormalized[blockIndex++] =
        absoluteError / (COLOR4_CAPTURE_FINGERPRINT_BLOCK_SIZE ** 2 * BYTE_MAXIMUM);
    }
  }
  const sorted = [...blockMaeNormalized].sort((left, right) => left - right);
  const p90Index = Math.ceil(0.9 * sorted.length) - 1;
  return Object.freeze({
    blockMaeNormalized: Object.freeze(blockMaeNormalized),
    p90MaeNormalized: sorted[p90Index]!,
  });
}

/** An absent comparison is warmup; threshold equality counts as stable. */
export function captureStabilityState(
  p90MaeNormalized: number | undefined,
  stableThreshold: number,
): CaptureStabilityState {
  assertNormalized(stableThreshold, "Stable threshold");
  if (p90MaeNormalized === undefined) return "warmup";
  assertNormalized(p90MaeNormalized, "Normalized p90 MAE");
  return p90MaeNormalized <= stableThreshold ? "stable" : "unstable";
}

/**
 * Observe mode is telemetry-only and never drops a frame. Enabled mode enforces
 * the two-frame rule, so both warmup and unstable captures are skipped.
 */
export function shouldSubmitCapture(
  mode: CaptureStabilityGateMode,
  state: CaptureStabilityState,
): boolean {
  return mode === "observe" || state === "stable";
}

/** Stateful convenience wrapper for consecutive camera fingerprints. */
export class CaptureStabilityTracker {
  private previous: Uint8Array | undefined;

  constructor(
    readonly mode: CaptureStabilityGateMode,
    readonly stableThreshold: number,
  ) {
    captureStabilityState(undefined, stableThreshold);
  }

  observe(current: Uint8Array): CaptureStabilityResult {
    assertFingerprint(current);
    const previous = this.previous;
    // Never retain a caller-owned mutable buffer.
    this.previous = current.slice();
    if (previous === undefined) {
      return Object.freeze({
        state: "warmup",
        shouldSubmit: shouldSubmitCapture(this.mode, "warmup"),
      });
    }
    const difference = compareCaptureLumaFingerprints(previous, current);
    const state = captureStabilityState(difference.p90MaeNormalized, this.stableThreshold);
    if (state === "warmup") throw new Error("A measured fingerprint difference cannot be warmup.");
    return Object.freeze({
      ...difference,
      state,
      shouldSubmit: shouldSubmitCapture(this.mode, state),
    });
  }

  reset(): void {
    this.previous = undefined;
  }
}
