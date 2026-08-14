import assert from "node:assert/strict";
import test from "node:test";
import {
  ROBUST_PROFILE,
  rasterizeColor4,
  wrapColor4Frame,
} from "../shared/color4/index.ts";
import { packFrame } from "../shared/protocol.ts";
import type {
  Color4WorkerRequest,
  Color4WorkerResponse,
} from "../receive/color4-worker-protocol.ts";

const CAMERA_WIDTH = 1_280;
const CAMERA_HEIGHT = 960;

function installImageData(): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
  if (previous !== undefined) return previous;
  class TestImageData {
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
    value: TestImageData,
  });
  return previous;
}

function centeredCamera(frame: ReturnType<typeof rasterizeColor4>): Uint8ClampedArray {
  assert.ok(frame.width < CAMERA_WIDTH);
  assert.ok(frame.height < CAMERA_HEIGHT);
  const pixels = new Uint8ClampedArray(CAMERA_WIDTH * CAMERA_HEIGHT * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 0xf4;
    pixels[offset + 1] = 0xf4;
    pixels[offset + 2] = 0xf4;
    pixels[offset + 3] = 0xff;
  }
  const left = Math.floor((CAMERA_WIDTH - frame.width) / 2);
  const top = Math.floor((CAMERA_HEIGHT - frame.height) / 2);
  const rowBytes = frame.width * 4;
  for (let y = 0; y < frame.height; y++) {
    const source = y * rowBytes;
    const destination = ((top + y) * CAMERA_WIDTH + left) * 4;
    pixels.set(frame.pixels.subarray(source, source + rowBytes), destination);
  }
  return pixels;
}

test("real worker entrypoint rejects an authenticated sequence/physical phase mismatch without retry", {
  timeout: 120_000,
}, async () => {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const previousImageData = installImageData();
  let resolveResponse: (response: Color4WorkerResponse) => void = () => undefined;
  const responsePromise = new Promise<Color4WorkerResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const workerScope: {
    onmessage: ((event: MessageEvent<Color4WorkerRequest>) => void) | null;
    postMessage(message: Color4WorkerResponse, transfer?: Transferable[]): void;
  } = {
    onmessage: null,
    postMessage: (message) => resolveResponse(message),
  };
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: workerScope,
  });

  try {
    const block = Uint8Array.from(
      { length: ROBUST_PROFILE.blockBytes },
      (_, index) => (index * 37 + 11) & 0xff,
    );
    const inner = packFrame({
      sessionId: 0x7319,
      seq: 0,
      k: 1,
      blockLen: block.length,
      totalLen: block.length,
      payloadFnv: 0x81f0_4a2d,
    }, block);
    const encoded = wrapColor4Frame(inner, {
      profileId: ROBUST_PROFILE.id,
      paletteId: 0,
    });
    const raster = rasterizeColor4(encoded.codedBytes, {
      profile: ROBUST_PROFILE,
      paletteId: 0,
      sequence: 1,
      moduleScale: 4,
    });
    const rgba = centeredCamera(raster);

    await import("../receive/color4-worker.ts");
    const onmessage = workerScope.onmessage;
    assert.ok(onmessage, "worker import must install its message entrypoint");
    onmessage({
      data: {
        kind: "decode",
        id: 17,
        width: CAMERA_WIDTH,
        height: CAMERA_HEIGHT,
        rgba: rgba.buffer,
        paletteId: 0,
        capturedAt: 0,
        captureMs: 0,
        debug: {
          enabled: false,
          view: "raw",
          generation: 0,
          canonicalScale: 6,
          maxDetectionDimension: 1_280,
          emitPlane: false,
          snapshot: false,
        },
      },
    } as MessageEvent<Color4WorkerRequest>);

    const response = await responsePromise;
    assert.equal(response.kind, "result");
    if (response.kind !== "result") return;
    assert.equal(response.status, "rejected");
    if (response.status !== "rejected") return;
    assert.equal(response.reason, "identity-mismatch");
    assert.equal(response.diagnostics.stage, "bootstrap");
    assert.equal(response.diagnostics.rejectReason, "sequence-phase-mismatch");
    assert.equal(response.diagnostics.vision?.diagnosticReason, "PHASE");
    assert.equal(response.diagnostics.unwrapAttempts?.length, 1);
    assert.equal(response.diagnostics.unwrapAttempts?.[0]?.status, "valid");
    assert.equal(response.diagnostics.rsFailures, 0);
    assert.equal(response.diagnostics.crcFailures, 0);
  } finally {
    if (previousSelf === undefined) delete (globalThis as { self?: unknown }).self;
    else Object.defineProperty(globalThis, "self", previousSelf);
    if (previousImageData === undefined) delete (globalThis as { ImageData?: unknown }).ImageData;
    else Object.defineProperty(globalThis, "ImageData", previousImageData);
  }
});
