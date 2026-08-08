/**
 * Public carrier contracts live with the COLOR_4 codec because both QR and
 * COLOR_4 must return the exact same legacy packFrame bytes. This module is the
 * browser-facing entry point and adds only UI/worker diagnostics.
 */
import type { CarrierId } from "./color4/types";

export type {
  CarrierId,
  CapturedFrame,
  Color4FrameContext,
  DecodeResult,
  FrameContext,
  FrameDiagnostics,
  RejectReason,
  RenderedFrame,
  VisualDecoder,
  VisualEncoder,
} from "./color4/types";

export type CarrierChoice = "qr" | "color4";

export function carrierId(choice: CarrierChoice): CarrierId {
  return choice === "color4" ? "COLOR_4" : "QR_LEGACY";
}

export interface BrowserCarrierDiagnostics {
  profile?: string;
  stage?:
    | "capture"
    | "geometry"
    | "bootstrap"
    | "calibration"
    | "classification"
    | "rs"
    | "crc"
    | "wire";
  candidates?: number;
  uncertainCells?: number;
  rsCorrectedSymbols?: number;
  rsFailures?: number;
  crcFailures?: number;
  erasureBytes?: number;
  confidence?: number;
  rejectReason?: string;
  decodeMs?: number;
}
