// Systematic Reed-Solomon over GF(256), primitive polynomial 0x11d, alpha=2.

const FIELD_SIZE = 256;
const FIELD_ORDER = FIELD_SIZE - 1;
const GF_EXP = new Uint8Array(FIELD_ORDER * 2);
const GF_LOG = new Uint8Array(FIELD_SIZE);

let fieldValue = 1;
for (let exponent = 0; exponent < FIELD_ORDER; exponent++) {
  GF_EXP[exponent] = fieldValue;
  GF_LOG[fieldValue] = exponent;
  fieldValue <<= 1;
  if (fieldValue & FIELD_SIZE) fieldValue ^= 0x11d;
}
for (let exponent = FIELD_ORDER; exponent < GF_EXP.length; exponent++) {
  GF_EXP[exponent] = GF_EXP[exponent - FIELD_ORDER]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero in GF(256).");
  if (a === 0) return 0;
  let exponent = GF_LOG[a]! - GF_LOG[b]!;
  if (exponent < 0) exponent += FIELD_ORDER;
  return GF_EXP[exponent]!;
}

function gfInverse(value: number): number {
  if (value === 0) throw new Error("Zero has no inverse in GF(256).");
  return GF_EXP[FIELD_ORDER - GF_LOG[value]!]!;
}

function gfPowAlpha(exponent: number): number {
  const normalized = ((exponent % FIELD_ORDER) + FIELD_ORDER) % FIELD_ORDER;
  return GF_EXP[normalized]!;
}

/** Polynomial coefficients are high-degree first. */
function polyMultiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let left = 0; left < a.length; left++) {
    for (let right = 0; right < b.length; right++) {
      out[left + right] = out[left + right]! ^ gfMul(a[left]!, b[right]!);
    }
  }
  return out;
}

function generatorPolynomial(parityBytes: number): Uint8Array {
  let generator: number[] = [1];
  for (let root = 0; root < parityBytes; root++) {
    generator = polyMultiply(generator, [1, gfPowAlpha(root)]);
  }
  return Uint8Array.from(generator);
}

function evaluateHighFirst(poly: Uint8Array, x: number): number {
  let value = poly[0] ?? 0;
  for (let index = 1; index < poly.length; index++) {
    value = gfMul(value, x) ^ poly[index]!;
  }
  return value;
}

function syndromes(codeword: Uint8Array, parityBytes: number): Uint8Array {
  const out = new Uint8Array(parityBytes);
  for (let root = 0; root < parityBytes; root++) {
    out[root] = evaluateHighFirst(codeword, gfPowAlpha(root));
  }
  return out;
}

function allZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

/** Remove known erasure exponentials from the syndrome sequence. */
function forneySyndromes(
  source: Uint8Array,
  erasures: readonly number[],
  codewordBytes: number,
): Uint8Array {
  let current = source.slice();
  for (const position of erasures) {
    const location = gfPowAlpha(codewordBytes - 1 - position);
    const next = new Uint8Array(current.length - 1);
    for (let index = 0; index < next.length; index++) {
      next[index] = gfMul(current[index]!, location) ^ current[index + 1]!;
    }
    current = next;
  }
  return current;
}

/** Berlekamp-Massey. Locator coefficients are ascending: 1 + l1*z + ... */
function errorLocator(sequence: Uint8Array): Uint8Array {
  const capacity = sequence.length + 1;
  let locator = new Uint8Array(capacity);
  let previous = new Uint8Array(capacity);
  locator[0] = 1;
  previous[0] = 1;
  let degree = 0;
  let shift = 1;
  let previousDiscrepancy = 1;

  for (let step = 0; step < sequence.length; step++) {
    let discrepancy = sequence[step]!;
    for (let coefficient = 1; coefficient <= degree; coefficient++) {
      discrepancy ^= gfMul(locator[coefficient]!, sequence[step - coefficient]!);
    }
    if (discrepancy === 0) {
      shift++;
      continue;
    }

    const saved = locator.slice();
    const scale = gfDiv(discrepancy, previousDiscrepancy);
    for (let index = 0; index + shift < locator.length; index++) {
      locator[index + shift] = locator[index + shift]! ^ gfMul(scale, previous[index]!);
    }
    if (2 * degree <= step) {
      degree = step + 1 - degree;
      previous = saved;
      previousDiscrepancy = discrepancy;
      shift = 1;
    } else {
      shift++;
    }
  }
  return locator.slice(0, degree + 1);
}

function evaluateAscending(poly: Uint8Array, x: number): number {
  let value = 0;
  for (let index = poly.length - 1; index >= 0; index--) {
    value = gfMul(value, x) ^ poly[index]!;
  }
  return value;
}

function findErrorPositions(locator: Uint8Array, codewordBytes: number): number[] | null {
  const degree = locator.length - 1;
  const positions: number[] = [];
  for (let position = 0; position < codewordBytes; position++) {
    const location = gfPowAlpha(codewordBytes - 1 - position);
    if (evaluateAscending(locator, gfInverse(location)) === 0) positions.push(position);
  }
  return positions.length === degree ? positions : null;
}

/** Solve the syndrome Vandermonde system for error magnitudes. */
function errorMagnitudes(
  sourceSyndromes: Uint8Array,
  positions: readonly number[],
  codewordBytes: number,
): Uint8Array | null {
  const size = positions.length;
  if (size === 0) return new Uint8Array();
  const matrix = Array.from({ length: size }, (_, row) => {
    const values = new Uint8Array(size + 1);
    for (let column = 0; column < size; column++) {
      const location = gfPowAlpha(codewordBytes - 1 - positions[column]!);
      values[column] = row === 0 ? 1 : gfPowAlpha(GF_LOG[location]! * row);
    }
    values[size] = sourceSyndromes[row]!;
    return values;
  });

  for (let column = 0; column < size; column++) {
    let pivot = column;
    while (pivot < size && matrix[pivot]![column] === 0) pivot++;
    if (pivot === size) return null;
    if (pivot !== column) [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];

    const inverse = gfInverse(matrix[column]![column]!);
    for (let entry = column; entry <= size; entry++) {
      matrix[column]![entry] = gfMul(matrix[column]![entry]!, inverse);
    }
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const scale = matrix[row]![column]!;
      if (scale === 0) continue;
      for (let entry = column; entry <= size; entry++) {
        matrix[row]![entry] =
          matrix[row]![entry]! ^ gfMul(scale, matrix[column]![entry]!);
      }
    }
  }

  return Uint8Array.from(matrix, (row) => row[size]!);
}

function normalizeErasures(
  positions: ArrayLike<number> | ReadonlySet<number>,
  codewordBytes: number,
): number[] | null {
  const values = positions instanceof Set ? [...positions] : Array.from(positions);
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (
    unique.some(
      (position) => !Number.isInteger(position) || position < 0 || position >= codewordBytes,
    )
  ) {
    return null;
  }
  return unique;
}

export interface ReedSolomonDecodeSuccess {
  readonly status: "corrected";
  readonly data: Uint8Array;
  readonly codeword: Uint8Array;
  readonly errors: number;
  readonly erasures: number;
  readonly correctedBytes: number;
  /**
   * Parity symbols left over after accounting for the damage that was located:
   * `parityBytes - erasures - 2 * errors`.
   *
   * A margin of zero means the correction consumed the whole code distance, so
   * the final syndrome check could not have failed: with `erasures` equal to
   * `parityBytes` the Vandermonde system is exactly determined and always
   * yields *a* zero-syndrome codeword, correct or not. Such a result is a valid
   * maximum-likelihood answer but carries no self-verification, so callers that
   * cannot check the payload by other means must not treat it as trustworthy.
   */
  readonly verificationMargin: number;
}

export interface ReedSolomonDecodeFailure {
  readonly status: "uncorrectable";
  readonly reason: "invalid-length" | "invalid-erasure" | "too-many-erasures" | "locator" | "verification";
}

export type ReedSolomonDecodeResult = ReedSolomonDecodeSuccess | ReedSolomonDecodeFailure;

export class ReedSolomonCodec {
  readonly dataBytes: number;
  readonly parityBytes: number;
  readonly codewordBytes: number;
  readonly #generator: Uint8Array;

  constructor(dataBytes: number, parityBytes: number) {
    const codewordBytes = dataBytes + parityBytes;
    if (
      !Number.isInteger(dataBytes) ||
      !Number.isInteger(parityBytes) ||
      dataBytes <= 0 ||
      parityBytes <= 0 ||
      codewordBytes > FIELD_ORDER
    ) {
      throw new Error("Reed-Solomon dimensions must be positive and total at most 255 bytes.");
    }
    this.dataBytes = dataBytes;
    this.parityBytes = parityBytes;
    this.codewordBytes = codewordBytes;
    this.#generator = generatorPolynomial(parityBytes);
  }

  encode(data: Uint8Array): Uint8Array {
    if (data.length !== this.dataBytes) {
      throw new Error(`RS encoder expected ${this.dataBytes} data bytes, received ${data.length}.`);
    }
    const working = new Uint8Array(this.codewordBytes);
    working.set(data);
    for (let index = 0; index < this.dataBytes; index++) {
      const coefficient = working[index]!;
      if (coefficient === 0) continue;
      for (let generatorIndex = 1; generatorIndex < this.#generator.length; generatorIndex++) {
        const target = index + generatorIndex;
        working[target] =
          working[target]! ^ gfMul(this.#generator[generatorIndex]!, coefficient);
      }
    }
    const out = new Uint8Array(this.codewordBytes);
    out.set(data);
    out.set(working.subarray(this.dataBytes), this.dataBytes);
    return out;
  }

  decode(
    codeword: Uint8Array,
    erasurePositions: ArrayLike<number> | ReadonlySet<number> = [],
  ): ReedSolomonDecodeResult {
    if (codeword.length !== this.codewordBytes) {
      return { status: "uncorrectable", reason: "invalid-length" };
    }
    const erasures = normalizeErasures(erasurePositions, this.codewordBytes);
    if (erasures === null) return { status: "uncorrectable", reason: "invalid-erasure" };
    if (erasures.length > this.parityBytes) {
      return { status: "uncorrectable", reason: "too-many-erasures" };
    }

    const originalSyndromes = syndromes(codeword, this.parityBytes);
    if (allZero(originalSyndromes)) {
      return {
        status: "corrected",
        data: codeword.slice(0, this.dataBytes),
        codeword: codeword.slice(),
        errors: 0,
        erasures: erasures.length,
        correctedBytes: 0,
        // An untouched codeword was verified against the full parity set.
        verificationMargin: this.parityBytes,
      };
    }

    const reducedSyndromes = forneySyndromes(
      originalSyndromes,
      erasures,
      this.codewordBytes,
    );
    const locator = errorLocator(reducedSyndromes);
    const unknownErrors = findErrorPositions(locator, this.codewordBytes);
    if (
      unknownErrors === null ||
      unknownErrors.some((position) => erasures.includes(position)) ||
      2 * unknownErrors.length + erasures.length > this.parityBytes
    ) {
      return { status: "uncorrectable", reason: "locator" };
    }

    const positions = [...erasures, ...unknownErrors];
    const magnitudes = errorMagnitudes(originalSyndromes, positions, this.codewordBytes);
    if (magnitudes === null) return { status: "uncorrectable", reason: "locator" };

    const corrected = codeword.slice();
    let correctedBytes = 0;
    for (let index = 0; index < positions.length; index++) {
      const magnitude = magnitudes[index]!;
      const position = positions[index]!;
      corrected[position] = corrected[position]! ^ magnitude;
      if (magnitude !== 0) correctedBytes++;
    }
    if (!allZero(syndromes(corrected, this.parityBytes))) {
      return { status: "uncorrectable", reason: "verification" };
    }
    return {
      status: "corrected",
      data: corrected.slice(0, this.dataBytes),
      codeword: corrected,
      errors: unknownErrors.length,
      erasures: erasures.length,
      correctedBytes,
      verificationMargin:
        this.parityBytes - erasures.length - 2 * unknownErrors.length,
    };
  }
}
