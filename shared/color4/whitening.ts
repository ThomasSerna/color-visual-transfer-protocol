import { splitmix32 } from "../protocol";

/** Domain-separated, normative COLOR_4/1 whitening seed. */
export function color4WhiteningSeed(profileId: number, paletteId: number): number {
  return (0x434f4c34 ^ ((profileId & 0xff) << 8) ^ (paletteId & 0xff)) >>> 0;
}

/**
 * XOR splitmix32 output into the byte plane. Each PRNG word is consumed
 * little-endian. Calling this twice with the same ids restores the input.
 */
export function whitenInPlace(bytes: Uint8Array, profileId: number, paletteId: number): void {
  const random = splitmix32(color4WhiteningSeed(profileId, paletteId));
  let word = 0;
  for (let index = 0; index < bytes.length; index++) {
    if ((index & 3) === 0) word = random();
    bytes[index] = bytes[index]! ^ ((word >>> ((index & 3) * 8)) & 0xff);
  }
}

export function whiten(bytes: Uint8Array, profileId: number, paletteId: number): Uint8Array {
  const out = bytes.slice();
  whitenInPlace(out, profileId, paletteId);
  return out;
}

