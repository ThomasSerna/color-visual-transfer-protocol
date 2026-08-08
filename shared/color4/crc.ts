/** CRC-8/ATM, used by the monochrome COLOR_4 bootstrap. */
export function crc8Atm(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** CRC32C Castagnoli, reflected form, init/xorout 0xffffffff. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function appendCrc32c(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes);
  new DataView(out.buffer).setUint32(bytes.length, crc32c(bytes), true);
  return out;
}

export function hasValidCrc32c(bytesWithCrc: Uint8Array): boolean {
  if (bytesWithCrc.length < 4) return false;
  const bodyLength = bytesWithCrc.length - 4;
  const view = new DataView(
    bytesWithCrc.buffer,
    bytesWithCrc.byteOffset + bodyLength,
    4,
  );
  return crc32c(bytesWithCrc.subarray(0, bodyLength)) === view.getUint32(0, true);
}

