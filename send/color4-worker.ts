import { renderColor4InnerFrame } from "./color4-render";
import type { Color4FrameContext } from "../shared/color4";

interface EncodeRequest {
  id: number;
  innerFrame: ArrayBuffer;
  context: Color4FrameContext;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, innerFrame, context } = event.data;
  try {
    const rendered = renderColor4InnerFrame(new Uint8Array(innerFrame), context);
    const rgba = new Uint8ClampedArray(rendered.rgba);
    scope.postMessage(
      { id, status: "valid", width: rendered.width, height: rendered.height, rgba: rgba.buffer },
      [rgba.buffer],
    );
  } catch (error) {
    scope.postMessage({
      id,
      status: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};
