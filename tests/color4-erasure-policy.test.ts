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
  type Color4ByteErasureCandidate,
  type Color4Profile,
  type Color4UnwrapResult,
  type RejectReason,
} from "../shared/color4/index.ts";
import { packFrame } from "../shared/protocol.ts";
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

function indices(
  profile: Color4Profile,
  shard: number,
  count: number,
  startPosition = 0,
): number[] {
  return Array.from(
    { length: count },
    (_, offset) => interleavedIndex(shard, startPosition + offset, profile.shards),
  );
}

function candidates(
  byteIndices: readonly number[],
  score: number | ((position: number) => number) = 1,
): Color4ByteErasureCandidate[] {
  return byteIndices.map((index, position) => ({
    index,
    score: typeof score === "number" ? score : score(position),
  }));
}

function damageAt(codedBytes: Uint8Array, byteIndices: readonly number[]): Uint8Array {
  const damaged = codedBytes.slice();
  for (const [position, index] of byteIndices.entries()) {
    damaged[index] = damaged[index]! ^ ((position % 0xfe) + 1);
  }
  return damaged;
}

function trackedUnwrap(calls: number[][]): typeof unwrapColor4Frame {
  return (codedBytes, options = {}) => {
    calls.push(Array.from(options.erasures ?? []));
    return unwrapColor4Frame(codedBytes, options);
  };
}

function staleCrcCodedBytes(profile: Color4Profile): Uint8Array {
  const wrapped = wrapColor4Frame(innerFrame(profile), {
    profileId: profile.id,
    paletteId: 0,
  });
  const pdu = wrapped.pdu.slice();
  pdu[100] = pdu[100]! ^ 1;
  const codedBytes = encodeColor4PduForTesting(pdu, profile);
  whitenInPlace(codedBytes, profile.id, 0);
  return codedBytes;
}

test("ranked selection normalizes duplicates, breaks ties by index, and does not mutate input", () => {
  const shardIndices = indices(ROBUST_PROFILE, 0, 33);
  const tiedInput = candidates([...shardIndices].reverse(), 1);
  const tiedBefore = structuredClone(tiedInput);
  const tied = selectFecBudgetedErasures(ROBUST_PROFILE, tiedInput);

  assert.deepEqual(tiedInput, tiedBefore);
  assert.deepEqual([...tied], shardIndices.slice(0, 32));

  const duplicateWinner = shardIndices[32]!;
  const duplicateInput = [
    ...candidates(shardIndices.slice(0, 32), 1),
    { index: duplicateWinner, score: 0.1 },
    { index: duplicateWinner, score: 2 },
  ];
  const duplicateBefore = structuredClone(duplicateInput);
  const selected = selectFecBudgetedErasures(ROBUST_PROFILE, duplicateInput);
  const expected = [...shardIndices.slice(0, 31), duplicateWinner].sort(
    (left, right) => left - right,
  );

  assert.deepEqual(duplicateInput, duplicateBefore);
  assert.deepEqual([...selected], expected);
  assert.equal(new Set(selected).size, selected.length);
});

test("ranked selection rejects invalid indices and scores", () => {
  const validIndex = interleavedIndex(0, 0, ROBUST_PROFILE.shards);
  for (const index of [-1, 1.5, ROBUST_PROFILE.codedBytes, Number.NaN]) {
    assert.throws(
      () => selectFecBudgetedErasures(ROBUST_PROFILE, [{ index, score: 1 }]),
      /Invalid COLOR_4 erasure candidate index/,
    );
  }
  for (const score of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => selectFecBudgetedErasures(ROBUST_PROFILE, [{ index: validIndex, score }]),
      /Invalid COLOR_4 erasure candidate score/,
    );
  }
});

test("zero candidates execute one hard-decision attempt", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  const calls: number[][] = [];
  const coordinated = runColor4ErasurePolicy({
    codedBytes: wrapped.codedBytes,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: [],
    expectedSequencePhase: 0,
    unwrap: trackedUnwrap(calls),
    clock: () => 0,
  });

  assert.deepEqual(calls, [[]]);
  assert.equal(coordinated.attempts.length, 1);
  assert.equal(coordinated.selectedPolicy, "hard-decision");
  assert.equal(coordinated.selectedBudgetFraction, 0);
  assert.equal(coordinated.selectedMaxErasuresPerShard, 0);
  assert.deepEqual(coordinated.suggestedErasuresByShard, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(coordinated.saturatedErasureShards, []);
  assert.equal(coordinated.attempts[0]!.phaseMatched, true);
  assert.equal(coordinated.result.status, "valid");
});

test("the full rung recovers the complete erasure budget in both profiles", () => {
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    const wrapped = wrapColor4Frame(innerFrame(profile), {
      profileId: profile.id,
      paletteId: 0,
    });
    const parity = profile.rsN - profile.rsK;
    const trueErasures = indices(profile, 0, parity);
    const coordinated = runColor4ErasurePolicy({
      codedBytes: damageAt(wrapped.codedBytes, trueErasures),
      profile,
      paletteId: 0,
      erasureCandidates: candidates(trueErasures, (position) => parity - position),
      expectedSequencePhase: 0,
      clock: () => 0,
    });

    assert.equal(coordinated.result.status, "valid", profile.name);
    assert.equal(coordinated.attempts.length, 1, profile.name);
    assert.equal(coordinated.selectedPolicy, "classifier-budgeted", profile.name);
    assert.equal(coordinated.selectedBudgetFraction, 1, profile.name);
    assert.equal(coordinated.selectedMaxErasuresPerShard, parity, profile.name);
    assert.deepEqual([...coordinated.selectedErasures], trueErasures, profile.name);
    assert.deepEqual(
      coordinated.attempts[0]!.erasuresByShard,
      [parity, ...Array.from({ length: profile.shards - 1 }, () => 0)],
      profile.name,
    );
    assert.equal(coordinated.attempts[0]!.phaseMatched, true, profile.name);
  }
});

test("each profile derives its ladder caps from Reed-Solomon parity", () => {
  for (const profile of [ROBUST_PROFILE, EXPERIMENTAL_PROFILE]) {
    const parity = profile.rsN - profile.rsK;
    const coordinated = runColor4ErasurePolicy({
      codedBytes: staleCrcCodedBytes(profile),
      profile,
      paletteId: 0,
      erasureCandidates: candidates(indices(profile, 0, parity + 1)),
      expectedSequencePhase: 0,
      clock: () => 0,
    });

    assert.deepEqual(
      coordinated.attempts.map(({ budgetFraction, maxErasuresPerShard }) => ({
        budgetFraction,
        maxErasuresPerShard,
      })),
      [
        { budgetFraction: 1, maxErasuresPerShard: parity },
        { budgetFraction: 0.75, maxErasuresPerShard: Math.floor(parity * 0.75) },
        { budgetFraction: 0.5, maxErasuresPerShard: Math.floor(parity * 0.5) },
        { budgetFraction: 0, maxErasuresPerShard: 0 },
      ],
      profile.name,
    );
  }
});

test("33 ranked candidates recover 17 real errors that hard-decision cannot", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  const trueErrors = indices(ROBUST_PROFILE, 0, 17);
  const falsePositives = indices(ROBUST_PROFILE, 0, 16, 100);
  const damaged = damageAt(wrapped.codedBytes, trueErrors);
  const hardDecision = unwrapColor4Frame(damaged, {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });

  assert.equal(hardDecision.status, "rejected");

  const coordinated = runColor4ErasurePolicy({
    codedBytes: damaged,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: [
      ...candidates(trueErrors, (position) => 100 - position),
      ...candidates(falsePositives, (position) => 1 - position / 100),
    ],
    expectedSequencePhase: 0,
    clock: () => 0,
  });

  assert.equal(coordinated.result.status, "valid");
  assert.equal(coordinated.attempts.length, 1);
  assert.equal(coordinated.selectedBudgetFraction, 1);
  assert.equal(coordinated.selectedErasures.length, 32);
  assert.ok(trueErrors.every((index) => coordinated.selectedErasures.includes(index)));
  assert.deepEqual(coordinated.suggestedErasuresByShard, [33, 0, 0, 0, 0, 0]);
  assert.deepEqual(coordinated.saturatedErasureShards, [0]);
});

test("the ladder behaves deterministically around the 2E + S correction boundary", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  const markedErrors = indices(ROBUST_PROFILE, 0, 8);
  const unknownErrors = indices(ROBUST_PROFILE, 0, 8, 20);
  const damaged = damageAt(wrapped.codedBytes, [...markedErrors, ...unknownErrors]);

  for (const erasureCount of [15, 16, 17]) {
    const falsePositiveCount = erasureCount - markedErrors.length;
    const falsePositives = indices(ROBUST_PROFILE, 0, falsePositiveCount, 100);
    const coordinated = runColor4ErasurePolicy({
      codedBytes: damaged,
      profile: ROBUST_PROFILE,
      paletteId: 0,
      erasureCandidates: [
        ...candidates(markedErrors, (position) => 4 - position / 100),
        ...candidates(falsePositives, (position) => 2 - position / 100),
      ],
      expectedSequencePhase: 0,
      clock: () => 0,
    });

    assert.equal(coordinated.result.status, "valid", `S=${erasureCount}`);
    if (erasureCount <= 16) {
      assert.deepEqual(
        coordinated.attempts.map(({ budgetFraction }) => budgetFraction),
        [1],
        `S=${erasureCount}`,
      );
    } else {
      assert.deepEqual(
        coordinated.attempts.map(({ budgetFraction, result }) => ({
          budgetFraction,
          status: result.status,
        })),
        [
          { budgetFraction: 1, status: "rejected" },
          { budgetFraction: 0.5, status: "valid" },
        ],
      );
      assert.equal(coordinated.selectedErasures.length, 16);
    }
  }
});

test("multiple shards use 100/75/50/0 caps, sorted indices, and bounded diagnostics", () => {
  const shard0 = indices(ROBUST_PROFILE, 0, 34);
  const shard1 = indices(ROBUST_PROFILE, 1, 33);
  const calls: number[][] = [];
  const coordinated = runColor4ErasurePolicy({
    codedBytes: staleCrcCodedBytes(ROBUST_PROFILE),
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: candidates([...shard1].reverse().concat([...shard0].reverse()), 1),
    expectedSequencePhase: 0,
    unwrap: trackedUnwrap(calls),
    clock: () => 0,
  });

  assert.equal(COLOR4_MAX_ERASURE_POLICY_ATTEMPTS, 4);
  assert.equal(coordinated.attempts.length, COLOR4_MAX_ERASURE_POLICY_ATTEMPTS);
  assert.deepEqual(
    coordinated.attempts.map(({ policy, budgetFraction, maxErasuresPerShard }) => ({
      policy,
      budgetFraction,
      maxErasuresPerShard,
    })),
    [
      { policy: "classifier-budgeted", budgetFraction: 1, maxErasuresPerShard: 32 },
      { policy: "classifier-budgeted", budgetFraction: 0.75, maxErasuresPerShard: 24 },
      { policy: "classifier-budgeted", budgetFraction: 0.5, maxErasuresPerShard: 16 },
      { policy: "hard-decision", budgetFraction: 0, maxErasuresPerShard: 0 },
    ],
  );
  assert.deepEqual(
    coordinated.attempts.map(({ erasuresByShard }) => erasuresByShard.slice(0, 2)),
    [[32, 32], [24, 24], [16, 16], [0, 0]],
  );
  assert.deepEqual(coordinated.suggestedErasuresByShard, [34, 33, 0, 0, 0, 0]);
  assert.deepEqual(coordinated.saturatedErasureShards, [0, 1]);
  for (const [position, call] of calls.entries()) {
    assert.deepEqual(call, [...call].sort((left, right) => left - right));
    assert.equal(
      coordinated.attempts[position]!.durationMs,
      coordinated.attempts[position]!.observations.reduce(
        (total, observation) => total + observation.durationMs,
        0,
      ),
    );
    assert.equal("phaseMatched" in coordinated.attempts[position]!, false);
  }
  assert.strictEqual(coordinated.result, coordinated.attempts[0]!.result);
  assert.strictEqual(coordinated.selectedObservations, coordinated.attempts[0]!.observations);
  assert.equal(coordinated.selectedBudgetFraction, 1);
});

test("duplicate rung selections and the empty set are each attempted once", () => {
  const hinted = [
    ...indices(ROBUST_PROFILE, 0, 8),
    ...indices(ROBUST_PROFILE, 1, 8),
  ];
  const calls: number[][] = [];
  const coordinated = runColor4ErasurePolicy({
    codedBytes: staleCrcCodedBytes(ROBUST_PROFILE),
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: candidates(hinted),
    expectedSequencePhase: 0,
    unwrap: trackedUnwrap(calls),
    clock: () => 0,
  });

  assert.deepEqual(
    coordinated.attempts.map(({ budgetFraction }) => budgetFraction),
    [1, 0],
  );
  assert.deepEqual(calls, [[...hinted].sort((left, right) => left - right), []]);
});

test("a valid phase mismatch continues to the next rung and a matching rung wins", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  const valid = unwrapColor4Frame(wrapped.codedBytes, {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  assert.equal(valid.status, "valid");
  if (valid.status !== "valid") return;

  const calls: number[][] = [];
  let call = 0;
  const phaseUnwrap: typeof unwrapColor4Frame = (_codedBytes, options = {}) => {
    calls.push(Array.from(options.erasures ?? []));
    const sequence = call++ === 0 ? 0x10203041 : 0x10203040;
    return { ...valid, header: { ...valid.header, sequence } };
  };
  const coordinated = runColor4ErasurePolicy({
    codedBytes: wrapped.codedBytes,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: candidates(indices(ROBUST_PROFILE, 0, 33)),
    expectedSequencePhase: 0,
    unwrap: phaseUnwrap,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    coordinated.attempts.map(({ budgetFraction, phaseMatched }) => ({
      budgetFraction,
      phaseMatched,
    })),
    [
      { budgetFraction: 1, phaseMatched: false },
      { budgetFraction: 0.75, phaseMatched: true },
    ],
  );
  assert.equal(coordinated.selectedBudgetFraction, 0.75);
  assert.equal(coordinated.result.status, "valid");
});

test("without a phase match, the first valid mismatch is retained after all rungs", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  const valid = unwrapColor4Frame(wrapped.codedBytes, {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  assert.equal(valid.status, "valid");
  if (valid.status !== "valid") return;

  const damaged = damageAt(wrapped.codedBytes, indices(ROBUST_PROFILE, 0, 17));
  const rejected = unwrapColor4Frame(damaged, {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  assert.equal(rejected.status, "rejected");
  if (rejected.status !== "rejected") return;

  let call = 0;
  const outcomes: readonly Color4UnwrapResult[] = [
    rejected,
    { ...valid, header: { ...valid.header, sequence: 0x10203041 } },
    rejected,
    rejected,
  ];
  const coordinated = runColor4ErasurePolicy({
    codedBytes: wrapped.codedBytes,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: candidates(indices(ROBUST_PROFILE, 0, 33)),
    expectedSequencePhase: 0,
    unwrap: (() => outcomes[call++]!) as typeof unwrapColor4Frame,
  });

  assert.equal(coordinated.attempts.length, 4);
  assert.equal(coordinated.selectedBudgetFraction, 0.75);
  assert.equal(coordinated.selectedPolicy, "classifier-budgeted");
  assert.equal(coordinated.attempts[1]!.phaseMatched, false);
  assert.strictEqual(coordinated.result, coordinated.attempts[1]!.result);
});

test("all valid phase mismatches exhaust the ladder and retain the first one", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  const valid = unwrapColor4Frame(wrapped.codedBytes, {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  assert.equal(valid.status, "valid");
  if (valid.status !== "valid") return;

  const mismatched = { ...valid, header: { ...valid.header, sequence: 0x10203041 } };
  const coordinated = runColor4ErasurePolicy({
    codedBytes: wrapped.codedBytes,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: candidates(indices(ROBUST_PROFILE, 0, 33)),
    expectedSequencePhase: 0,
    unwrap: (() => mismatched) as typeof unwrapColor4Frame,
  });

  assert.equal(coordinated.attempts.length, 4);
  assert.ok(coordinated.attempts.every(({ phaseMatched }) => phaseMatched === false));
  assert.equal(coordinated.selectedBudgetFraction, 1);
  assert.strictEqual(coordinated.result, coordinated.attempts[0]!.result);
});

test("when every rung rejects, the first rejection remains authoritative", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  const fecRejected = unwrapColor4Frame(
    damageAt(wrapped.codedBytes, indices(ROBUST_PROFILE, 0, 17)),
    { profileId: ROBUST_PROFILE.id, paletteId: 0 },
  );
  const crcRejected = unwrapColor4Frame(staleCrcCodedBytes(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  assert.equal(fecRejected.status, "rejected");
  assert.equal(crcRejected.status, "rejected");
  if (fecRejected.status !== "rejected" || crcRejected.status !== "rejected") return;
  assert.equal(fecRejected.reason, "fec-uncorrectable");
  assert.equal(crcRejected.reason, "crc-mismatch");

  let call = 0;
  const outcomes: readonly Color4UnwrapResult[] = [
    fecRejected,
    crcRejected,
    crcRejected,
    crcRejected,
  ];
  const coordinated = runColor4ErasurePolicy({
    codedBytes: wrapped.codedBytes,
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: candidates(indices(ROBUST_PROFILE, 0, 33)),
    expectedSequencePhase: 0,
    unwrap: (() => outcomes[call++]!) as typeof unwrapColor4Frame,
  });

  assert.equal(coordinated.attempts.length, 4);
  assert.strictEqual(coordinated.result, fecRejected);
  assert.equal(coordinated.selectedBudgetFraction, 1);
  assert.equal(coordinated.result.reason, "fec-uncorrectable");
});

test("the budget ladder cannot bypass CRC validation", () => {
  const coordinated = runColor4ErasurePolicy({
    codedBytes: staleCrcCodedBytes(ROBUST_PROFILE),
    profile: ROBUST_PROFILE,
    paletteId: 0,
    erasureCandidates: candidates(indices(ROBUST_PROFILE, 0, 33)),
    expectedSequencePhase: 0,
    clock: () => 0,
  });

  assert.equal(coordinated.attempts.length, 4);
  assert.deepEqual(
    coordinated.attempts.map(({ result }) =>
      result.status === "rejected" ? result.reason : result.status
    ),
    ["crc-mismatch", "crc-mismatch", "crc-mismatch", "crc-mismatch"],
  );
  assert.equal(coordinated.selectedBudgetFraction, 1);
  assert.equal(coordinated.result.status, "rejected");
});

test("the budget ladder cannot bypass outer, inner, or identity validation", () => {
  const wrapped = wrapColor4Frame(innerFrame(ROBUST_PROFILE), {
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
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
      erasureCandidates: candidates(indices(ROBUST_PROFILE, 0, 33)),
      expectedSequencePhase: 0,
      clock: () => 0,
    });

    assert.equal(coordinated.attempts.length, 4, corruption.name);
    assert.deepEqual(
      coordinated.attempts.map(({ result }) =>
        result.status === "rejected" ? result.reason : result.status
      ),
      Array.from({ length: 4 }, () => corruption.reason),
      corruption.name,
    );
    assert.equal(coordinated.selectedBudgetFraction, 1, corruption.name);
    assert.equal(coordinated.result.status, "rejected", corruption.name);
    if (coordinated.result.status === "rejected") {
      assert.equal(coordinated.result.reason, corruption.reason, corruption.name);
    }
  }
});
