/** Convert shard-major codewords into the normative position-major stream. */
export function interleaveCodewords(
  codewords: readonly Uint8Array[],
  codewordBytes = 255,
): Uint8Array {
  if (codewords.length === 0) throw new Error("At least one RS codeword is required.");
  if (codewords.some((codeword) => codeword.length !== codewordBytes)) {
    throw new Error("Every RS codeword must have the configured length.");
  }
  const out = new Uint8Array(codewords.length * codewordBytes);
  for (let position = 0; position < codewordBytes; position++) {
    for (let shard = 0; shard < codewords.length; shard++) {
      out[position * codewords.length + shard] = codewords[shard]![position]!;
    }
  }
  return out;
}

/** Convert a position-major stream back into shard-major codewords. */
export function deinterleaveCodewords(
  stream: Uint8Array,
  shards: number,
  codewordBytes = 255,
): Uint8Array[] {
  if (!Number.isInteger(shards) || shards <= 0 || stream.length !== shards * codewordBytes) {
    throw new Error("The interleaved stream length does not match its shard geometry.");
  }
  const codewords = Array.from({ length: shards }, () => new Uint8Array(codewordBytes));
  for (let position = 0; position < codewordBytes; position++) {
    for (let shard = 0; shard < shards; shard++) {
      codewords[shard]![position] = stream[position * shards + shard]!;
    }
  }
  return codewords;
}

export function interleavedIndex(shard: number, position: number, shards: number): number {
  return position * shards + shard;
}

export function shardPosition(index: number, shards: number): { shard: number; position: number } {
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(shards) || shards <= 0) {
    throw new Error("Invalid interleaved byte index.");
  }
  return { shard: index % shards, position: Math.floor(index / shards) };
}

