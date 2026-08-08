import { renderQrInnerFrame, type QrErrorCorrectionLevel } from "./qr-render";
import type { FrameContext } from "../shared/carrier";

interface EncodeRequest {
  readonly id: number;
  readonly innerFrame: ArrayBuffer;
  readonly context: FrameContext;
  readonly errorCorrectionLevel: QrErrorCorrectionLevel;
  readonly margin: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

// A worker belongs to exactly one QR visual encoder/session. Message events
// run in order, so the first frame selects the version and every later frame
// is forced to that same version exactly as the original sender did.
let lockedVersion: number | undefined;

scope.onmessage = (event) => {
  const { id, innerFrame, context, errorCorrectionLevel, margin } = event.data;
  try {
    const rendered = renderQrInnerFrame(
      new Uint8Array(innerFrame),
      context,
      errorCorrectionLevel,
      margin,
      lockedVersion,
    );
    lockedVersion ??= rendered.version;
    scope.postMessage(
      {
        id,
        status: "valid",
        width: rendered.width,
        height: rendered.height,
        rgba: rendered.rgba.buffer,
        version: rendered.version,
        moduleCount: rendered.moduleCount,
      },
      [rendered.rgba.buffer],
    );
  } catch (error) {
    scope.postMessage({
      id,
      status: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};
