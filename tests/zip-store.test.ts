import assert from "node:assert/strict";
import test from "node:test";
import { createStoredZip, createStoredZipBytes, crc32Ieee } from "../shared/zip-store.ts";

interface ParsedEntry {
  name: string;
  bytes: Uint8Array;
  crc: number;
}

function parseLocalEntries(bytes: Uint8Array): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out: ParsedEntry[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 6, true), 0x0800, "UTF-8 flag");
    assert.equal(view.getUint16(offset + 8, true), 0, "STORE method");
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    assert.equal(view.getUint32(offset + 22, true), size);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    out.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      bytes: bytes.slice(dataStart, dataStart + size),
      crc,
    });
    offset = dataStart + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, "central directory follows data");
  return out;
}

test("stored ZIP snapshots have portable names, bytes and IEEE CRC-32", async () => {
  const raw = Uint8Array.from([0, 1, 2, 3, 254, 255]);
  const threshold = Uint8Array.from([0, 255, 0, 255]);
  const json = new TextEncoder().encode('{"warped":{"available":false}}\n');
  const bytes = await createStoredZipBytes([
    { name: "capture-007-raw.png", data: raw, modifiedAt: new Date("2026-08-08T12:00:00Z") },
    { name: "capture-007-threshold.png", data: threshold, modifiedAt: new Date("2026-08-08T12:00:00Z") },
    { name: "capture-007.json", data: new Blob([json]), modifiedAt: new Date("2026-08-08T12:00:00Z") },
  ]);
  const entries = parseLocalEntries(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "capture-007-raw.png",
    "capture-007-threshold.png",
    "capture-007.json",
  ]);
  assert.deepEqual(entries[0]!.bytes, raw);
  assert.deepEqual(entries[1]!.bytes, threshold);
  assert.deepEqual(entries[2]!.bytes, json);
  assert.equal(
    entries.some((entry) => entry.name === "capture-007-warped.png"),
    false,
    "warped PNG is validly absent when homography did not complete",
  );
  for (const entry of entries) assert.equal(entry.crc, crc32Ieee(entry.bytes));

  const archive = await createStoredZip([{ name: "capture-007.json", data: json }]);
  assert.equal(archive.type, "application/zip");
  assert.ok(archive.size > json.length);
});

test("ZIP CRC-32 matches the standard check vector", () => {
  assert.equal(crc32Ieee(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("stored ZIP rejects ambiguous or unsafe paths", async () => {
  await assert.rejects(
    createStoredZipBytes([
      { name: "capture.json", data: new Uint8Array() },
      { name: "capture.json", data: new Uint8Array() },
    ]),
    /Duplicate ZIP entry/,
  );
  await assert.rejects(
    createStoredZipBytes([{ name: "../capture.json", data: new Uint8Array() }]),
    /Unsafe ZIP entry name/,
  );
});
