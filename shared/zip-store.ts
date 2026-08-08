export interface StoredZipEntry {
  readonly name: string;
  readonly data: Uint8Array | ArrayBuffer | Blob;
  readonly modifiedAt?: Date;
}

interface PreparedEntry {
  readonly name: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly time: number;
  readonly date: number;
  readonly localOffset: number;
}

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_HEADER_BYTES = 22;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const VERSION = 20;

const crcTable = (() => {
  const out = new Uint32Array(256);
  for (let index = 0; index < out.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    out[index] = value >>> 0;
  }
  return out;
})();

/** Standard reflected IEEE CRC-32 used by ZIP, not COLOR_4's CRC32C. */
export function crc32Ieee(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function validName(name: string): void {
  const segments = name.split("/");
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    segments.some((segment) => segment === ".." || segment.length === 0)
  ) {
    throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(name)}.`);
  }
}

function dosTimestamp(input: Date): { date: number; time: number } {
  const value = Number.isFinite(input.getTime()) ? input : new Date(0);
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = Math.floor(value.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

async function bytesOf(data: StoredZipEntry["data"]): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return Uint8Array.from(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(await data.arrayBuffer());
}

function setHeader(
  output: Uint8Array,
  offset: number,
  signature: number,
  entry: PreparedEntry,
  central: boolean,
): void {
  const view = new DataView(output.buffer, output.byteOffset + offset);
  view.setUint32(0, signature, true);
  if (central) {
    view.setUint16(4, VERSION, true);
    view.setUint16(6, VERSION, true);
    view.setUint16(8, UTF8_FLAG, true);
    view.setUint16(10, STORE_METHOD, true);
    view.setUint16(12, entry.time, true);
    view.setUint16(14, entry.date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.data.length, true);
    view.setUint32(24, entry.data.length, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, entry.localOffset, true);
  } else {
    view.setUint16(4, VERSION, true);
    view.setUint16(6, UTF8_FLAG, true);
    view.setUint16(8, STORE_METHOD, true);
    view.setUint16(10, entry.time, true);
    view.setUint16(12, entry.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, entry.name.length, true);
    view.setUint16(28, 0, true);
  }
}

/**
 * Build a dependency-free ZIP archive using STORE entries. PNG is already
 * compressed, so deflate would add CPU and memory without helping snapshots.
 */
export async function createStoredZipBytes(entries: readonly StoredZipEntry[]): Promise<Uint8Array> {
  if (entries.length === 0) throw new Error("A ZIP archive needs at least one entry.");
  if (entries.length > 0xffff) throw new Error("ZIP entry count exceeds the classic format.");
  const names = new Set<string>();
  const encoder = new TextEncoder();
  const prepared: PreparedEntry[] = [];
  let localBytes = 0;
  for (const source of entries) {
    validName(source.name);
    if (names.has(source.name)) throw new Error(`Duplicate ZIP entry: ${source.name}.`);
    names.add(source.name);
    const name = encoder.encode(source.name);
    const data = await bytesOf(source.data);
    if (name.length > 0xffff || data.length > 0xffffffff) {
      throw new Error(`ZIP entry is too large: ${source.name}.`);
    }
    const stamp = dosTimestamp(source.modifiedAt ?? new Date());
    prepared.push({
      name,
      data,
      crc: crc32Ieee(data),
      ...stamp,
      localOffset: localBytes,
    });
    localBytes += LOCAL_HEADER_BYTES + name.length + data.length;
  }
  const centralBytes = prepared.reduce(
    (total, entry) => total + CENTRAL_HEADER_BYTES + entry.name.length,
    0,
  );
  const totalBytes = localBytes + centralBytes + END_HEADER_BYTES;
  if (totalBytes > 0xffffffff) throw new Error("ZIP archive exceeds the classic format.");
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const entry of prepared) {
    setHeader(output, offset, 0x04034b50, entry, false);
    offset += LOCAL_HEADER_BYTES;
    output.set(entry.name, offset);
    offset += entry.name.length;
    output.set(entry.data, offset);
    offset += entry.data.length;
  }
  const centralOffset = offset;
  for (const entry of prepared) {
    setHeader(output, offset, 0x02014b50, entry, true);
    offset += CENTRAL_HEADER_BYTES;
    output.set(entry.name, offset);
    offset += entry.name.length;
  }
  const end = new DataView(output.buffer, output.byteOffset + offset, END_HEADER_BYTES);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, prepared.length, true);
  end.setUint16(10, prepared.length, true);
  end.setUint32(12, centralBytes, true);
  end.setUint32(16, centralOffset, true);
  end.setUint16(20, 0, true);
  return output;
}

export async function createStoredZip(entries: readonly StoredZipEntry[]): Promise<Blob> {
  const bytes = await createStoredZipBytes(entries);
  return new Blob([bytes as BlobPart], { type: "application/zip" });
}
