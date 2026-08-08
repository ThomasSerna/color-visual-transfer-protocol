import QRCode from "qrcode";
import { parseFrame } from "../shared/protocol";
import { rasterizeQr } from "../shared/qr-raster";
import type { FrameContext, RenderedFrame } from "../shared/carrier";

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export interface QrRenderedFrame extends RenderedFrame {
  /** The QR version selected for this fixed-size Decimen stream. */
  readonly version: number;
  /** Module count before the quiet-zone margin is added. */
  readonly moduleCount: number;
}

/**
 * Render one legacy Decimen packFrame without changing a byte of its payload.
 *
 * Keeping this pure makes the worker path directly comparable with the
 * original main-thread implementation. `version` is omitted for the first
 * frame and pinned for every later frame in the same visual encoder session.
 */
export function renderQrInnerFrame(
  innerFrame: Uint8Array,
  context: FrameContext,
  errorCorrectionLevel: QrErrorCorrectionLevel,
  margin: number,
  version?: number,
): QrRenderedFrame {
  const parsed = parseFrame(innerFrame);
  if (
    !parsed ||
    parsed.header.sessionId !== context.sessionId ||
    parsed.header.seq !== context.sequence
  ) {
    throw new Error("QR context does not match the inner Decimen frame.");
  }
  const qr = QRCode.create(
    [{ data: innerFrame, mode: "byte" } as unknown as QRCode.QRCodeSegment],
    {
      errorCorrectionLevel,
      version,
      // This is the exact mask used by Decimen v0.3.0. It is a wire-visible
      // QR choice, so the adapter must never let the library auto-select it.
      maskPattern: 4,
    },
  );
  const raster = rasterizeQr(qr.modules.size, qr.modules.data, margin);
  return {
    width: raster.size,
    height: raster.size,
    rgba: new Uint8ClampedArray(raster.pixels.buffer),
    version: qr.version,
    moduleCount: qr.modules.size,
  };
}
