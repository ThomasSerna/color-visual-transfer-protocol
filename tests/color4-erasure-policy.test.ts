import assert from "node:assert/strict";
import test from "node:test";
import {
  COLOR4_OUTER_HEADER_BYTES,
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
  appendCrc32c,
  encodeColor4PduForTesting,
  interleavedIndex,
  unwrapColor4Frame,
  whitenInPlace,
  wrapColor4Frame,
  type Color4Profile,
  type RejectReason,
} from "../shared/color4/index.ts";
import { packFrame } from "../shared/protocol.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";
import {
  COLOR4_MAX_ERASURE_POLICY_ATTEMPTS,
  runColor4ErasurePolicy,
  selectFecBudgetedErasures,
} from "../receive/color4-erasure-policy.ts";

function innerFrame(profile: Color4Profile): Uint8Array {
  const totalLen = 12_345;
  return packFrame(
    {
      sessionId: 0xbeef,
      seq: 0x10203040,
      k: Math.ceil(totalLen / profile.blockBytes),
      blockLen: profile.blockBytes,
      totalLen,
      payloadFnv: 0x89abcdef,
    },
    Uint8Array.from(
      { length: profile.blockBytes },
      (_, index) => (index * 37 + 7) & 0xff,
    ),
  );
}

function indices(profile: Color4Profile, shard: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, position) => interleavedIndex(shard, position, profile.shards),
  );
}

function damageShard(codedBytes: Uint8Array, profile: Color4Profile, count: number): Uint8Array {
  const damaged = codedBytes.slice();
  for (let error = 0; error < count; error++) {
    const index = interleavedIndex(0, error * 7, profile.shards);
    damaged[index] = damaged[index]! ^ (error + 1);
  }
  return damaged;
}

function trackedUnwrap(calls: number[][]): typeof unwrapColor4Frame {
  return (codedBytes, options = {}) => {
    calls.push(Array.from(options.erasures as Uint16Array | undefined ?? []));
    return unwrapColor4Frame(codedBytes, options);
  };
}

test("FEC-budgeted selection keeps complete feasible shards and clears saturated shards", () => {
  const robustInput = [
    ...indices(ROBUST_PROFILE, 1, 33).reverse(),
    ...indices(ROBUST_PROFILE, 0, 32),
    interleavedIndex(0, 0, ROBUST_PROFILE.shards),
  ];
  const robust = selectFecBudgetedErasures(ROBUST_PROFILE, robustInput);
  assert.deepEqual([...robust], indices(ROBUST_PROFILE, 0, 32));

  const experimentalInput = [
    ...indices(EXPERIMENTAL_PROFILE, 2, 17),
    ...indices(EXPERIMENTAL_PROFILE, 3, 16),
  ];
  const experimental = selectFecBudgetedErasures(EXPERIMENTAL_PROFILE, experimentalInput);
  assert.deepEqual([...experimental], indices(EXPERIMENTAL_PROFILE, 3, 16));

  for (const invalid of [-1, 1.5, ROBUST_PROFILE.codedBytes]) {
    assert.throws(
      () => selectFecBudgetedErasures(ROBUST_PROFILE, [invalid]),
      /Invalid COLOR_4 erasure index/,
    );
  }
});

test("coordinator retries once without erasures and selects the validating result", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), { profileId: 1, paletteId: 0 });
  const damaged = damageShard(wrapped.codedBytes, ROBUST_PROFILE, 16);
  const falseErasure = interleavedIndex(0, 200, ROBUST_PROFILE.shards);
  const calls: number[][] = [];
  const coordinated = runColor4ErasurePolicy({
    codedBytes: damaged,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasures: Uint16Array.of(falseErasure),
    unwrap: trackedUnwrap(calls),
    clock: () => 0,
  });

  assert.equal(COLOR4_MAX_ERASURE_POLICY_ATTEMPTS, 2);
  assert.deepEqual(calls, [[falseErasure], []]);
  assert.equal(coordinated.attempts.length, 2);
  assert.deepEqual(
    coordinated.attempts.map(({ policy, result }) => ({ policy, status: result.status })),
    [
      { policy: "classifier-budgeted", status: "rejected" },
      { policy: "hard-decision", status: "valid" },
    ],
  );
  assert.equal(coordinated.selectedPolicy, "hard-decision");
  assert.equal(coordinated.selectedErasures.length, 0);
  assert.equal(coordinated.result.status, "valid");
  if (coordinated.result.status === "valid") {
    assert.deepEqual(coordinated.result.innerFrame, wrapped.pdu.subarray(16, 16 + ROBUST_PROFILE.innerFrameBytes));
    assert.equal(coordinated.result.diagnostics.correctedErrors, 16);
  }
});

test("a valid non-empty primary is deterministic, immutable, and never triggers fallback", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), { profileId: 1, paletteId: 0 });
  const damaged = damageShard(wrapped.codedBytes, ROBUST_PROFILE, 1);
  const markedError = interleavedIndex(0, 0, ROBUST_PROFILE.shards);
  const input = Uint16Array.of(markedError);
  const before = input.slice();
  const firstCalls: number[][] = [];
  const secondCalls: number[][] = [];
  const first = runColor4ErasurePolicy({
    codedBytes: damaged,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasures: input,
    unwrap: trackedUnwrap(firstCalls),
    clock: () => 0,
  });
  const second = runColor4ErasurePolicy({
    codedBytes: damaged,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasures: input,
    unwrap: trackedUnwrap(secondCalls),
    clock: () => 0,
  });

  assert.deepEqual(input, before);
  assert.deepEqual(firstCalls, [[markedError]]);
  assert.deepEqual(secondCalls, firstCalls);
  assert.equal(first.attempts.length, 1);
  assert.equal(first.selectedPolicy, "classifier-budgeted");
  assert.equal(first.result.status, "valid");
  assert.deepEqual(first, second);
  if (first.result.status === "valid") {
    assert.equal(color4SequencePhaseMatches(first.result.header.sequence, 1), false);
  }
  assert.equal(first.attempts.length, 1, "a later phase mismatch must not cause another unwrap");
});

test("coordinator is bounded, deduplicates an empty candidate, and preserves primary failure", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), { profileId: 1, paletteId: 0 });
  const falseErasure = interleavedIndex(0, 200, ROBUST_PROFILE.shards);
  const calls: number[][] = [];
  const failed = runColor4ErasurePolicy({
    codedBytes: damageShard(wrapped.codedBytes, ROBUST_PROFILE, 17),
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasures: Uint16Array.of(falseErasure),
    unwrap: trackedUnwrap(calls),
    clock: () => 0,
  });

  assert.deepEqual(calls, [[falseErasure], []]);
  assert.equal(failed.attempts.length, COLOR4_MAX_ERASURE_POLICY_ATTEMPTS);
  assert.equal(failed.selectedPolicy, "classifier-budgeted");
  assert.strictEqual(failed.selectedObservations, failed.attempts[0]!.observations);
  assert.equal(failed.result.status, "rejected");
  if (failed.result.status === "rejected") {
    assert.equal(failed.result.reason, "fec-uncorrectable");
    assert.equal(failed.result.diagnostics.erasures, 1);
  }

  const saturatedCalls: number[][] = [];
  const saturated = runColor4ErasurePolicy({
    codedBytes: wrapped.codedBytes,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasures: Uint16Array.from(indices(ROBUST_PROFILE, 0, 33)),
    unwrap: trackedUnwrap(saturatedCalls),
    clock: () => 0,
  });
  assert.deepEqual(saturatedCalls, [[]]);
  assert.equal(saturated.attempts.length, 1);
  assert.deepEqual(saturated.suggestedErasuresByShard, [33, 0, 0, 0, 0, 0]);
  assert.deepEqual(saturated.saturatedErasureShards, [0]);
  assert.deepEqual(saturated.attempts[0]!.erasuresByShard, [0, 0, 0, 0, 0, 0]);
});

test("bounded fallback cannot bypass CRC validation", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), { profileId: 1, paletteId: 0 });
  const staleCrcPdu = wrapped.pdu.slice();
  staleCrcPdu[100] = staleCrcPdu[100]! ^ 1;
  const staleCrcCoded = encodeColor4PduForTesting(staleCrcPdu, ROBUST_PROFILE);
  whitenInPlace(staleCrcCoded, ROBUST_PROFILE.id, 0);

  const coordinated = runColor4ErasurePolicy({
    codedBytes: staleCrcCoded,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasures: Uint16Array.of(interleavedIndex(0, 200, ROBUST_PROFILE.shards)),
    clock: () => 0,
  });

  assert.equal(coordinated.attempts.length, 2);
  assert.deepEqual(
    coordinated.attempts.map(({ result }) =>
      result.status === "rejected" ? result.reason : result.status
    ),
    ["crc-mismatch", "crc-mismatch"],
  );
  assert.equal(coordinated.selectedPolicy, "classifier-budgeted");
  assert.equal(coordinated.result.status, "rejected");
  if (coordinated.result.status === "rejected") {
    assert.equal(coordinated.result.reason, "crc-mismatch");
  }
});

test("bounded fallback cannot bypass outer, inner, or identity validation", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), { profileId: 1, paletteId: 0 });
  const falseErasure = interleavedIndex(0, 200, ROBUST_PROFILE.shards);
  const corruptions: readonly {
    readonly name: string;
    readonly reason: RejectReason;
    readonly mutate: (body: Uint8Array) => void;
  }[] = [
    {
      name: "outer header",
      reason: "invalid-outer-header",
      mutate: (body) => {
        body[6] = 0;
      },
    },
    {
      name: "inner frame",
      reason: "invalid-inner-frame",
      mutate: (body) => {
        body[COLOR4_OUTER_HEADER_BYTES] = 0;
      },
    },
    {
      name: "outer/inner identity",
      reason: "identity-mismatch",
      mutate: (body) => {
        new DataView(body.buffer, body.byteOffset, body.byteLength).setUint16(10, 0x1234, true);
      },
    },
  ];

  for (const corruption of corruptions) {
    const body = wrapped.pdu.slice(0, -4);
    corruption.mutate(body);
    const codedBytes = encodeColor4PduForTesting(appendCrc32c(body), ROBUST_PROFILE);
    whitenInPlace(codedBytes, ROBUST_PROFILE.id, 0);

    const coordinated = runColor4ErasurePolicy({
      codedBytes,
      profile: ROBUST_PROFILE,
      paletteId: 0,
      erasures: Uint16Array.of(falseErasure),
      clock: () => 0,
    });

    assert.equal(coordinated.attempts.length, 2, corruption.name);
    assert.deepEqual(
      coordinated.attempts.map(({ result }) =>
        result.status === "rejected" ? result.reason : result.status
      ),
      [corruption.reason, corruption.reason],
      corruption.name,
    );
    assert.equal(coordinated.selectedPolicy, "classifier-budgeted", corruption.name);
    assert.equal(coordinated.result.status, "rejected", corruption.name);
    if (coordinated.result.status === "rejected") {
      assert.equal(coordinated.result.reason, corruption.reason, corruption.name);
    }
  }
});
