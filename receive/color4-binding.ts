/** Bind the redundant physical phase pilot to the authenticated inner sequence. */
export function color4SequencePhaseMatches(
  sequence: number,
  physicalPhase: 0 | 1 | 2 | 3,
): boolean {
  return Number.isInteger(sequence) && sequence >= 0 && sequence <= 0xffff_ffff &&
    (sequence & 0x03) === physicalPhase;
}
