/**
 * Turning COLOR_4 capture measurements into one piece of advice worth acting on.
 *
 * The receiver already measures why a frame is unreadable — pixels per module,
 * fiducial contrast, inter-frame stability — but until now it only counted
 * those numbers into the experiment telemetry. A user watching a receiver that
 * never decodes has no way to learn that the code is simply too small in frame.
 *
 * Optical resolution is the dominant constraint and the one the user can fix
 * fastest, so it is reported first. Below roughly four camera pixels per module
 * a single module is blurred into its neighbours badly enough that no amount of
 * classifier work recovers the payload, which is exactly the regime a distant
 * or windowed sender lands in.
 *
 * This module has no DOM in it: the debounce rules are the part that can be
 * wrong, and rendering a line of text is not.
 */

import {
  COLOR4_GOOD_PIXELS_PER_MODULE,
  COLOR4_MINIMUM_FIDUCIAL_CONTRAST,
} from "./color4-capture-quality";
import type { BrowserVisionDiagnostics } from "../shared/carrier";
import type { CaptureStabilityState } from "./color4-capture-stability";

export type Color4FramingProblem =
  /** The code resolves too few camera pixels per module to classify colour. */
  | "TOO_SMALL"
  /** Fiducials are found but the frame is too dim to separate black from white. */
  | "TOO_DIM"
  /** Consecutive captures disagree: motion blur or autofocus hunting. */
  | "UNSTABLE"
  /** Geometry never locks: the code is out of frame, occluded or unrecognisable. */
  | "NOT_FOUND";

export interface Color4FramingAdvice {
  readonly problem: Color4FramingProblem;
  /** One short sentence naming the fix, suitable for a status toast. */
  readonly headline: string;
  /** Ordered, specific follow-ups for the troubleshooting dialog. */
  readonly tips: readonly string[];
}

const ADVICE: Readonly<Record<Color4FramingProblem, Color4FramingAdvice>> = Object.freeze({
  TOO_SMALL: Object.freeze({
    problem: "TOO_SMALL",
    headline: "The code is too small in frame — move closer.",
    tips: Object.freeze([
      "Move the camera closer until the coloured square nearly fills this preview.",
      "On the sending device, tap the code to go fullscreen — a windowed sender wastes most of the screen.",
      "Raise the sending screen's resolution or zoom the page in if fullscreen is not available.",
    ]),
  }),
  TOO_DIM: Object.freeze({
    problem: "TOO_DIM",
    headline: "Not enough contrast — raise the sender's brightness.",
    tips: Object.freeze([
      "Turn the sending screen's brightness all the way up.",
      "Move out of direct light, and tilt the screen away from reflections and glare.",
      "Avoid shooting the screen at a steep angle: LCD panels lose contrast off-axis.",
    ]),
  }),
  UNSTABLE: Object.freeze({
    problem: "UNSTABLE",
    headline: "The camera is moving — prop it against something.",
    tips: Object.freeze([
      "Rest the phone against a solid object; hand tremor alone is enough to blur a frame.",
      "Wait for autofocus to settle before expecting frames to decode.",
      "Keep both devices still for the whole transfer.",
    ]),
  }),
  NOT_FOUND: Object.freeze({
    problem: "NOT_FOUND",
    headline: "No code detected — point the camera at the sender.",
    tips: Object.freeze([
      "Fit all four corner markers inside the preview, including the white margin around them.",
      "Check the sending device is actually transmitting on the COLOR_4 carrier.",
      "Keep the whole code flat and unobstructed.",
    ]),
  }),
});

export function color4FramingAdvice(problem: Color4FramingProblem): Color4FramingAdvice {
  return ADVICE[problem];
}

export interface Color4FramingSample {
  readonly stability: CaptureStabilityState | undefined;
  readonly vision: BrowserVisionDiagnostics | undefined;
}

const FIDUCIAL_IDS = ["TL", "TR", "BR", "BL"] as const;

/**
 * Classify a single capture. Ordered by what blocks decoding first: an unstable
 * or unlocatable frame yields no trustworthy optical measurements at all, so
 * those are ruled out before resolution and contrast are read.
 */
export function color4FramingProblem(
  sample: Color4FramingSample,
): Color4FramingProblem | undefined {
  const { stability, vision } = sample;
  if (stability === "unstable") return "UNSTABLE";
  if (stability === undefined || stability === "warmup") return undefined;

  const fiducials = vision?.fiducials;
  if (fiducials !== undefined && FIDUCIAL_IDS.some((id) => !fiducials[id]?.found)) {
    return "NOT_FOUND";
  }

  const optical = vision?.optical;
  if (optical === undefined) return undefined;
  // Resolution first: it bounds what any downstream stage can achieve, and it is
  // the measurement the user can move to fix.
  if (optical.minimumPixelsPerModule < COLOR4_GOOD_PIXELS_PER_MODULE) return "TOO_SMALL";
  if (optical.fiducialContrast < COLOR4_MINIMUM_FIDUCIAL_CONTRAST) return "TOO_DIM";
  return undefined;
}

/** Captures inspected before any advice is offered. */
export const COLOR4_FRAMING_WINDOW = 8;
/** Agreeing captures required within the window to commit to one problem. */
export const COLOR4_FRAMING_QUORUM = 5;

/**
 * Majority vote over a short rolling window.
 *
 * Single captures are noisy — autofocus, a passing hand, one bad exposure — and
 * advice that flickers between three different instructions is worse than none.
 * A problem is only reported once most of the recent window agrees on it, and a
 * decoded frame clears the state outright because the link demonstrably works.
 */
export class Color4FramingAdviceTracker {
  readonly #window: (Color4FramingProblem | undefined)[] = [];

  constructor(
    private readonly windowSize: number = COLOR4_FRAMING_WINDOW,
    private readonly quorum: number = COLOR4_FRAMING_QUORUM,
  ) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError("Framing advice window must be a positive integer.");
    }
    if (!Number.isInteger(quorum) || quorum <= 0 || quorum > windowSize) {
      throw new RangeError("Framing advice quorum must be a positive integer within the window.");
    }
  }

  observe(sample: Color4FramingSample): void {
    this.#window.push(color4FramingProblem(sample));
    while (this.#window.length > this.windowSize) this.#window.shift();
  }

  /** The problem most of the recent window agrees on, if any has reached quorum. */
  get advice(): Color4FramingAdvice | undefined {
    const counts = new Map<Color4FramingProblem, number>();
    for (const problem of this.#window) {
      if (problem === undefined) continue;
      counts.set(problem, (counts.get(problem) ?? 0) + 1);
    }
    let leader: Color4FramingProblem | undefined;
    let leaderCount = 0;
    for (const [problem, count] of counts) {
      // Ties keep the incumbent, so a 50/50 split does not oscillate.
      if (count > leaderCount) {
        leader = problem;
        leaderCount = count;
      }
    }
    return leader !== undefined && leaderCount >= this.quorum
      ? color4FramingAdvice(leader)
      : undefined;
  }

  /** A frame decoded, or the camera restarted: previous evidence is stale. */
  reset(): void {
    this.#window.length = 0;
  }
}
