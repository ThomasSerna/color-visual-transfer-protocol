import {
  COLOR4_PROFILES,
  getColor4Profile,
  type Color4FrameContext,
  type Color4PaletteId,
  type Color4ProfileId,
  type RenderedFrame,
  type VisualEncoder,
} from "../shared/color4";
import { TOTAL_MODULES } from "../shared/color4/physical";

export { COLOR4_PROFILES };
export const COLOR4_CANONICAL_MODULES = TOTAL_MODULES;

type WorkerResponse =
  | { id: number; status: "valid"; width: number; height: number; rgba: ArrayBuffer }
  | { id: number; status: "rejected"; reason: string };

export class Color4VisualEncoder implements VisualEncoder<Color4FrameContext> {
  readonly carrier = "COLOR_4" as const;
  private readonly worker = new Worker(new URL("./color4-worker.ts", import.meta.url), {
    type: "module",
  });
  private nextId = 0;
  private disposed = false;
  private readonly pending = new Map<
    number,
    { resolve: (frame: RenderedFrame) => void; reject: (reason: Error) => void }
  >();

  constructor(
    readonly profileId: Color4ProfileId,
    readonly paletteId: Color4PaletteId,
  ) {
    if (getColor4Profile(profileId) === undefined) throw new RangeError("Unknown COLOR_4 profile.");
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.status === "rejected") pending.reject(new Error(response.reason));
      else {
        pending.resolve({
          width: response.width,
          height: response.height,
          rgba: new Uint8ClampedArray(response.rgba),
        });
      }
    };
    const fail = () => this.failAll(new Error("The COLOR_4 encoder worker stopped unexpectedly."));
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;
  }

  encode(innerFrame: Uint8Array, context: Color4FrameContext): Promise<RenderedFrame> {
    if (this.disposed) return Promise.reject(new Error("COLOR_4 encoder is disposed."));
    if (context.profileId !== this.profileId || context.paletteId !== this.paletteId) {
      return Promise.reject(new Error("COLOR_4 encoder context does not match its configuration."));
    }
    const id = this.nextId++;
    // packFrame() owns this fresh buffer. A copy keeps this adapter safe for
    // callers that provide a view into shared state, then transfers ownership.
    const transferred = Uint8Array.from(innerFrame);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(
        { id, innerFrame: transferred.buffer, context },
        [transferred.buffer],
      );
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.failAll(new Error("COLOR_4 encoder was disposed."));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createColor4Encoder(
  profileId: Color4ProfileId,
  paletteId: Color4PaletteId,
): Color4VisualEncoder {
  return new Color4VisualEncoder(profileId, paletteId);
}
