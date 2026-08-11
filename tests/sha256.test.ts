import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../shared/sha256";

test("sha256Hex hashes the exact byte sequence", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.notEqual(await sha256Hex(new Uint8ClampedArray([0, 1, 2])), await sha256Hex(new Uint8Array([0, 1, 3])));
});
