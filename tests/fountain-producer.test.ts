import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LTEncoder } from "../shared/fountain.ts";
import { fnv1a, packFrame } from "../shared/protocol.ts";
import { FountainFrameGenerator } from "../send/fountain-frame.ts";
import { FountainFrameProducer } from "../send/fountain-producer.ts";
import type {
  FountainWorkerRequest,
  FountainWorkerResponse,
} from "../send/fountain-worker-protocol.ts";

function testPayload(): Uint8Array {
  return Uint8Array.from(
    { length: 4_099 },
    (_, index) => (Math.imul(index, 73) + (index >>> 3) + 19) & 0xff,
  );
}

test("fountain worker generator preserves legacy LT and packFrame bytes", () => {
  const payload = testPayload();
  const blockLen = 223;
  const sessionId = 0xbeef;
  const generator = new FountainFrameGenerator(payload, blockLen, sessionId);
  const legacy = new LTEncoder(payload, blockLen, sessionId);
  const sequences = [0, 1, 17, 65_537, 0xffff_ffff];
  const hash = createHash("sha256");

  assert.deepEqual(generator.metadata, {
    sessionId,
    k: 19,
    blockLen,
    totalLen: payload.length,
    payloadFnv: 0x88e8_24ad,
  });
  for (const sequence of sequences) {
    const actual = generator.encode(sequence);
    const expected = packFrame(
      {
        sessionId,
        seq: sequence,
        k: legacy.k,
        blockLen,
        totalLen: payload.length,
        payloadFnv: fnv1a(payload),
      },
      legacy.encode(sequence),
    );
    assert.deepEqual(actual, expected);
    hash.update(actual);
  }
  assert.equal(
    hash.digest("hex"),
    "04dd9de78f33b1aa23da89044f268ec5f01ad5b9b0e93bfd83fd32da4fb70e6d",
  );
});

class FakeFountainWorker {
  onmessage: ((event: MessageEvent<FountainWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly sent: Array<{ message: FountainWorkerRequest; transfer: Transferable[] }> = [];
  terminated = false;

  postMessage(message: FountainWorkerRequest, transfer: Transferable[] = []): void {
    this.sent.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: FountainWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<FountainWorkerResponse>);
  }
}

test("fountain producer owns one session copy and transfers packed frames", async () => {
  const payload = testPayload();
  const originalFirstByte = payload[0]!;
  const worker = new FakeFountainWorker();
  const producer = new FountainFrameProducer(payload, 223, 0xbeef, worker as unknown as Worker);
  const init = worker.sent[0]!;
  assert.equal(init.message.kind, "init");
  if (init.message.kind !== "init") return;
  assert.notEqual(init.message.payload, payload.buffer);
  assert.deepEqual(new Uint8Array(init.message.payload), payload);
  assert.deepEqual(init.transfer, [init.message.payload]);
  payload[0] = originalFirstByte ^ 0xff;
  assert.equal(new Uint8Array(init.message.payload)[0], originalFirstByte);

  const metadata = {
    sessionId: 0xbeef,
    k: 19,
    blockLen: 223,
    totalLen: payload.length,
    payloadFnv: 0x88e8_24ad,
  } as const;
  worker.reply({ kind: "ready", metadata });
  assert.deepEqual(await producer.ready, metadata);

  const pending = producer.encode(77);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const request = worker.sent[1]!.message;
  assert.deepEqual(request, { kind: "frame", id: 0, sequence: 77 });
  const packed = Uint8Array.from([0x44, 0x46, 1, 2, 3]);
  worker.reply({ kind: "frame", id: 0, innerFrame: packed.buffer });
  assert.deepEqual(await pending, packed);

  producer.dispose();
  assert.equal(worker.terminated, true);
});

test("sender UI delegates LT encoding and packFrame to the common worker", () => {
  const source = readFileSync(new URL("../send/main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bLTEncoder\b/);
  assert.doesNotMatch(source, /\bpackFrame\s*\(/);
  assert.match(source, /await fountain\.encode\(sequence\)/);
});
