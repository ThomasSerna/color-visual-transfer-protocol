/**
 * Receiver defaults shared by runtime code, HTML generation and vision.
 *
 * Keep this module dependency-free: the QR-only standalone receiver imports
 * the camera defaults, while the optional COLOR_4 worker imports the vision
 * defaults.
 */
export const DEFAULT_QR_CAPTURE_WIDTH = 1280 as const;
export const DEFAULT_COLOR4_CAPTURE_WIDTH = 1920 as const;
/** Backward-compatible build-time default for the initially selected QR carrier. */
export const DEFAULT_CAPTURE_WIDTH = DEFAULT_QR_CAPTURE_WIDTH;
export const DEFAULT_COLOR4_CAPTURE_FPS = 30 as const;
export const DEFAULT_QR_CAPTURE_FPS = 60 as const;
export const DEFAULT_COLOR4_CANONICAL_SCALE = 6 as const;
export const DEFAULT_COLOR4_DETECTION_DIMENSION = 1280 as const;

export type ReceiverCarrierChoice = "qr" | "color4";

export function defaultCaptureWidth(carrier: ReceiverCarrierChoice): 1280 | 1920 {
  return carrier === "color4" ? DEFAULT_COLOR4_CAPTURE_WIDTH : DEFAULT_QR_CAPTURE_WIDTH;
}

export function defaultCaptureFps(carrier: ReceiverCarrierChoice): 30 | 60 {
  return carrier === "color4" ? DEFAULT_COLOR4_CAPTURE_FPS : DEFAULT_QR_CAPTURE_FPS;
}
