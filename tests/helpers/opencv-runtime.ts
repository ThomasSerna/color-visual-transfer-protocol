/**
 * Node-side OpenCV.js bootstrap shared by the vision tests.
 *
 * The receiver's vision module builds `ImageData` directly, which Node does not
 * define, so a minimal structural stand-in is installed before OpenCV is used.
 * The corpus and physical-replay tests each grew their own copy of this; new
 * callers use this one.
 */

import type { OpenCvRuntime } from "../../receive/color4-vision.ts";

export function installImageData(): void {
  if (typeof ImageData !== "undefined") return;
  class NodeImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  Object.defineProperty(globalThis, "ImageData", {
    configurable: true,
    value: NodeImageData,
  });
}

let runtime: Promise<OpenCvRuntime> | undefined;

/** Load OpenCV.js once per process and wait for its WASM runtime to initialize. */
export async function loadOpenCvRuntime(): Promise<OpenCvRuntime> {
  installImageData();
  runtime ??= (async () => {
    const imported = (await import("@techstark/opencv-js")) as unknown as Record<string, unknown>;
    const candidate = (imported.default ?? imported) as
      | Record<string, unknown>
      | Promise<Record<string, unknown>>;
    const resolved = await Promise.resolve(candidate);
    if (resolved.ready && typeof (resolved.ready as Promise<unknown>).then === "function") {
      await resolved.ready;
    } else if (resolved.Mat === undefined) {
      await new Promise<void>((resolve) => {
        resolved.onRuntimeInitialized = resolve;
      });
    }
    return resolved as unknown as OpenCvRuntime;
  })();
  return runtime;
}
