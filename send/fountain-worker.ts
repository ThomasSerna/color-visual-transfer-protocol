import { FountainFrameGenerator } from "./fountain-frame";
import type { FountainWorkerRequest, FountainWorkerResponse } from "./fountain-worker-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FountainWorkerRequest>) => void) | null;
  postMessage(message: FountainWorkerResponse, transfer?: Transferable[]): void;
};

let generator: FountainFrameGenerator | undefined;

scope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.kind === "init") {
      if (generator) throw new Error("The fountain worker is already initialized.");
      generator = new FountainFrameGenerator(
        new Uint8Array(request.payload),
        request.blockLen,
        request.sessionId,
      );
      scope.postMessage({ kind: "ready", metadata: generator.metadata });
      return;
    }

    if (!generator) throw new Error("The fountain worker is not initialized.");
    const innerFrame = generator.encode(request.sequence);
    scope.postMessage(
      { kind: "frame", id: request.id, innerFrame: innerFrame.buffer },
      [innerFrame.buffer],
    );
  } catch (error) {
    scope.postMessage({
      kind: "error",
      ...(request.kind === "frame" ? { id: request.id } : {}),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};
