import type { CarrierChoice } from "./carrier";

export type CaptureWidthChoice = 960 | 1280 | 1920 | "max";

export interface CameraConstraintAttempt {
  readonly label: "selected-exact" | "fallback-1280-exact" | "ideal";
  readonly constraints: MediaTrackConstraints;
}

function commonConstraints(): MediaTrackConstraints {
  return { facingMode: "environment" };
}

function dimensions(width: number, exact: boolean): MediaTrackConstraints {
  const value = exact ? { exact: width } : { ideal: width };
  return {
    width: value,
    // Camera sensors do not all expose a 4:3 mode for every width. Keep the
    // height non-fatal while still expressing the intended capture shape.
    height: { ideal: Math.round((width * 3) / 4) },
  };
}

/**
 * Ordered camera attempts. COLOR_4 pins spatial resolution and cadence before
 * falling back; QR retains its historically permissive width negotiation.
 * `max` opens a safe 1280 mode first and is upgraded from track capabilities
 * after getUserMedia succeeds.
 */
export function cameraConstraintLadder(
  carrier: CarrierChoice,
  width: CaptureWidthChoice,
  fps: number,
): readonly CameraConstraintAttempt[] {
  const requestedWidth = width === "max" ? 1280 : width;
  const common = commonConstraints();
  if (carrier === "qr") {
    return [
      {
        label: "selected-exact",
        constraints: {
          ...common,
          ...dimensions(requestedWidth, false),
          frameRate: { exact: fps },
        },
      },
      {
        label: "ideal",
        constraints: {
          ...common,
          ...dimensions(requestedWidth, false),
          frameRate: { ideal: fps },
        },
      },
    ];
  }

  const attempts: CameraConstraintAttempt[] = [
    {
      label: "selected-exact",
      constraints: {
        ...common,
        ...dimensions(requestedWidth, true),
        frameRate: { exact: fps },
      },
    },
  ];
  if (requestedWidth !== 1280) {
    attempts.push({
      label: "fallback-1280-exact",
      constraints: {
        ...common,
        ...dimensions(1280, true),
        frameRate: { exact: fps },
      },
    });
  }
  attempts.push({
    label: "ideal",
    constraints: {
      ...common,
      ...dimensions(requestedWidth, false),
      frameRate: { ideal: fps },
    },
  });
  return attempts;
}

export interface MaxWidthApplication {
  readonly attempted?: number;
  readonly applied: boolean;
}

/** Best-effort `max supported` upgrade; actual getSettings remains authoritative. */
export async function applyMaximumSupportedWidth(
  track: MediaStreamTrack,
  fps: number,
): Promise<MaxWidthApplication> {
  const maximum = track.getCapabilities?.().width?.max;
  if (!Number.isFinite(maximum) || maximum === undefined || maximum <= 0) {
    return { applied: false };
  }
  const attempted = Math.floor(maximum);
  try {
    await track.applyConstraints({
      width: { exact: attempted },
      height: { ideal: Math.round((attempted * 3) / 4) },
      frameRate: { exact: fps },
    });
    return { attempted, applied: true };
  } catch {
    return { attempted, applied: false };
  }
}
