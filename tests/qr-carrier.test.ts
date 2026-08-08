import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { packFrame } from "../shared/protocol.ts";
import type { PoolWorker } from "../shared/worker-pool.ts";
import { QrLegacyCameraDecoder } from "../receive/qr-carrier.ts";
import { renderQrInnerFrame } from "../send/qr-render.ts";

function legacyFrame(sequence = 0x1020_3040): Uint8Array {
  const block = Uint8Array.from({ length: 96 }, (_, index) => (index * 29 + 7) & 0xff);
  return packFrame(
    {
      sessionId: 0x1234,
      seq: sequence,
      k: 7,
      blockLen: block.length,
      totalLen: 613,
      payloadFnv: 0x89ab_cdef,
    },
    block,
  );
}

test("QR_LEGACY worker renderer stays pixel-exact with Decimen's pinned QR choices", () => {
  const rendered = renderQrInnerFrame(
    legacyFrame(),
    { sessionId: 0x1234, sequence: 0x1020_3040 },
    "L",
    4,
  );
  assert.deepEqual(
    { version: rendered.version, modules: rendered.moduleCount, size: rendered.width },
    { version: 6, modules: 41, size: 49 },
  );
  assert.equal(
    createHash("sha256").update(rendered.rgba).digest("hex"),
    "d440608be356d7333c79455bbe1b08f5846db8b14f9b5e4c0622aea97182df5d",
  );
});

test("QR_LEGACY renderer rejects a context that disagrees with packFrame", () => {
  assert.throws(
    () =>
      renderQrInnerFrame(
        legacyFrame(),
        { sessionId: 0x1234, sequence: 1 },
        "L",
        4,
      ),
    /context does not match/,
  );
});

class FakeWorker implements PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  sent: Array<{ id: number }> = [];

  postMessage(message: unknown): void {
    this.sent.push(message as { id: number });
  }

  terminate(): void {}

  reply(bytes: Uint8Array | null): void {
    const id = this.sent.at(-1)!.id;
    this.onmessage?.({ data: { id, bytes } } as MessageEvent);
  }
}

class TestImageData {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

function capturedFrame(): { source: ImageData; timestamp: number } {
  return { source: new TestImageData(8, 8) as unknown as ImageData, timestamp: 1 };
}

test("QR_LEGACY decoder adapter validates inner bytes and reports decode latency", async () => {
  const originalImageData = globalThis.ImageData;
  Object.defineProperty(globalThis, "ImageData", { value: TestImageData, configurable: true });
  try {
    const worker = new FakeWorker();
    const times = [10, 17];
    const decoder = new QrLegacyCameraDecoder({
      workerCount: 1,
      createWorker: () => worker,
      now: () => times.shift()!,
    });
    const pending = decoder.decode(capturedFrame());
    worker.reply(legacyFrame());
    const result = await pending;
    assert.equal(result.status, "valid");
    assert.equal(result.diagnostics.decodeMs, 7);
    assert.equal(result.diagnostics.stage, "wire");
    assert.equal(result.diagnostics.candidates, 1);
    if (result.status === "valid") assert.deepEqual(result.innerFrame, legacyFrame());
    decoder.dispose();
  } finally {
    Object.defineProperty(globalThis, "ImageData", {
      value: originalImageData,
      configurable: true,
    });
  }
});

test("QR_LEGACY decoder distinguishes no symbol from a hostile QR payload", async () => {
  const originalImageData = globalThis.ImageData;
  Object.defineProperty(globalThis, "ImageData", { value: TestImageData, configurable: true });
  try {
    const worker = new FakeWorker();
    let now = 0;
    const decoder = new QrLegacyCameraDecoder({
      workerCount: 1,
      createWorker: () => worker,
      now: () => now++,
    });

    const missing = decoder.decode(capturedFrame());
    worker.reply(null);
    assert.equal((await missing).status, "rejected");
    const hostile = decoder.decode(capturedFrame());
    worker.reply(new Uint8Array([1, 2, 3]));
    assert.deepEqual(
      { status: (await hostile).status, busy: decoder.busy },
      { status: "rejected", busy: false },
    );
    decoder.dispose();
  } finally {
    Object.defineProperty(globalThis, "ImageData", {
      value: originalImageData,
      configurable: true,
    });
  }
});
