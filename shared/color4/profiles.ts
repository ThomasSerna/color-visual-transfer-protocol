/** Normative COLOR_4/1 physical/FEC profile identifiers. */
export type Color4ProfileId = 1 | 2;

export interface Color4Profile {
  readonly id: Color4ProfileId;
  readonly name: "ROBUST" | "EXPERIMENTAL";
  readonly columns: number;
  readonly rows: number;
  readonly shards: number;
  readonly rsN: 255;
  readonly rsK: 223 | 239;
  readonly codedBytes: number;
  readonly pduBytes: number;
  readonly innerFrameBytes: 1318 | 3326;
  readonly blockBytes: 1298 | 3306;
  readonly minHoldCycles: number;
}

export const ROBUST_PROFILE: Color4Profile = Object.freeze({
  id: 1,
  name: "ROBUST",
  columns: 72,
  rows: 85,
  shards: 6,
  rsN: 255,
  rsK: 223,
  codedBytes: 1_530,
  pduBytes: 1_338,
  innerFrameBytes: 1_318,
  blockBytes: 1_298,
  minHoldCycles: 6,
});

export const EXPERIMENTAL_PROFILE: Color4Profile = Object.freeze({
  id: 2,
  name: "EXPERIMENTAL",
  columns: 120,
  rows: 119,
  shards: 14,
  rsN: 255,
  rsK: 239,
  codedBytes: 3_570,
  pduBytes: 3_346,
  innerFrameBytes: 3_326,
  blockBytes: 3_306,
  minHoldCycles: 2,
});

export const COLOR4_PROFILES: readonly Color4Profile[] = Object.freeze([
  ROBUST_PROFILE,
  EXPERIMENTAL_PROFILE,
]);

export function getColor4Profile(id: number): Color4Profile | undefined {
  return COLOR4_PROFILES.find((profile) => profile.id === id);
}

