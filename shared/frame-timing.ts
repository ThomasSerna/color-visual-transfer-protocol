const DISPLAY_TIMING_BASELINE_FPS = 60;

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

/** Minimum real time represented by a profile's legacy 60 Hz cycle count. */
export function minimumHoldMs(minHoldCycles: number): number {
  positiveFinite(minHoldCycles, "minHoldCycles");
  return (minHoldCycles * 1000) / DISPLAY_TIMING_BASELINE_FPS;
}

/**
 * Real-time hold policy: respect both the requested transmit rate and the
 * profile's minimum exposure at the historical 60 Hz display baseline.
 */
export function effectiveHoldMs(txFps: number, minHoldCycles: number): number {
  positiveFinite(txFps, "txFps");
  return Math.max(1000 / txFps, minimumHoldMs(minHoldCycles));
}

/**
 * Pure temporal gate for a requestAnimationFrame-driven producer.
 *
 * A frame is dequeued only when it may replace the displayed frame. Empty
 * queues do not advance the clock, and every successful presentation resets
 * the hold from the real timestamp, so pauses can never create catch-up bursts.
 */
export class TemporalFrameScheduler {
  readonly effectiveHoldMs: number;
  private lastPresentedAt: number | undefined;

  constructor(txFps: number, minHoldCycles: number) {
    this.effectiveHoldMs = effectiveHoldMs(txFps, minHoldCycles);
  }

  take<T>(now: number, dequeue: () => T | undefined): T | undefined {
    if (!Number.isFinite(now)) throw new RangeError("now must be finite.");
    if (
      this.lastPresentedAt !== undefined &&
      now < this.lastPresentedAt + this.effectiveHoldMs - 1e-6
    ) {
      return undefined;
    }
    const frame = dequeue();
    if (frame === undefined) return undefined;
    this.lastPresentedAt = now;
    return frame;
  }
}
