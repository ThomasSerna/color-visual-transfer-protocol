# COLOR_4/1 physical-carrier specification

Status: **MVP specification**. Multi-byte integers are little-endian unless
stated otherwise. Constants in this document are normative.

## Compatibility boundary

COLOR_4 is a visual carrier around one unmodified Decimen `packFrame` value.
After visual decoding and error correction, a receiver MUST obtain those exact
bytes and pass them to the upstream `parseFrame` and `LTDecoder`. DCF2, gzip,
SHA-256, the 20-byte Decimen frame header and fountain distribution are not
versioned or modified here.

Changing carrier, profile or palette starts a new fountain session. Parameters
MUST remain fixed within a session. The carrier has no start frame, end frame,
acknowledgement or return channel.

## Outer PDU

The PDU before forward-error correction is:

```text
outerHeader[16] || innerFrame[innerLength] || crc32c[4]
```

| Offset | Width | Field | Required value |
|---:|---:|---|---|
| 0 | 3 | magic | ASCII `DC4` (`44 43 34`) |
| 3 | 1 | `phyVersion` | `1` |
| 4 | 1 | `profileId` | `1` or `2` |
| 5 | 1 | `paletteId` | `0` stable, `1` Labs |
| 6 | 1 | flags | `0x03` (whitening and interleaving) |
| 7 | 1 | `headerLength` | `16` |
| 8 | 2 | `innerLength` | exact `innerFrame` length |
| 10 | 2 | `sessionId` | copy from the inner header |
| 12 | 4 | `sequence` | copy from the inner header |

CRC32C uses the reflected Castagnoli polynomial `0x82F63B78`, initial value
`0xffffffff`, final XOR `0xffffffff`, and covers the header and inner frame.
Its four result bytes are stored little-endian.

A receiver MUST reject an unknown version, profile, palette or flags; a length
that does not exactly match the profile; a CRC mismatch; or a copied session
or sequence that differs from the inner header. It MUST do this before passing
bytes to the fountain decoder.

## Profiles

| ID | Name | Data cells | RS layout | Inner frame | LT block | Nominal rate |
|---:|---|---:|---:|---:|---:|---:|
| 1 | ROBUST | 72×85 | 6×RS(255,223) | 1,318 B | 1,298 B | 5 fps |
| 2 | EXPERIMENTAL | 120×119 | 14×RS(255,239) | 3,326 B | 3,306 B | Labs, 15–60 fps |

The profile PDU capacities are respectively 1,338 and 3,346 bytes. Both cover
the largest legal Decimen container without overflowing its `K` u16.

## FEC and mapping

Reed–Solomon operates over GF(256), primitive polynomial `0x11D`, alpha 2,
with systematic codewords `[data | parity]`. The PDU fills all data shards; a
ROBUST PDU is exactly `6 × 223 = 1,338` bytes and EXPERIMENTAL PDU is exactly
`14 × 239 = 3,346` bytes. COLOR_4 adds no data-shard padding. Any padding in
the last LT source block belongs to the unchanged inner Decimen fountain
format, before `packFrame`.

Transmission order is:

```text
PDU
  → split into B data shards
  → append Reed–Solomon parity
  → interleave codeword[position][shard]
  → XOR deterministic whitening stream
  → map each byte MSB-first to four dibit cells
```

Interleaving emits `codeword[shard][position]` at
`stream[position * shardCount + shard]`. Whitening reuses Decimen's exact
`splitmix32`; its seed is
`0x434f4c34 ^ (profileId << 8) ^ paletteId`. Each generated word supplies four
little-endian mask bytes.

The four cells for a byte carry bits `7..6`, `5..4`, `3..2`, `1..0`. If any
cell is uncertain, the complete byte is an RS erasure. A shard is correctable
only when `2 * unknownErrors + erasures <= paritySymbols`. Any uncorrectable
shard or failed CRC rejects the complete visual frame.

## Palettes

Stable palette 0:

| Dibit | Symbol | sRGB |
|---|---|---|
| `00` | K | `#101010` |
| `01` | C | `#00D8D8` |
| `10` | M | `#D800D8` |
| `11` | Y | `#D8D800` |

Palette 1 (K/R/G/B) is for comparative experiments and MUST be labelled Labs.
Receivers classify measured colour in Lab D65 after per-frame calibration;
exact RGB equality is never a decoding rule.

## Physical frame

### Coordinate system and common layout

The canonical raster is `172 × 172` logical modules: a `160 × 160` active
square plus exactly six white quiet-zone modules on every side. One side of
the quiet zone is therefore `6 / 172 = 3.488%` of the complete side. Coordinates
below are `(x, y, width, height)` in the active square, before adding the quiet
zone, with `(0, 0)` at top left, x increasing right and y increasing down.
Unassigned active modules are white.

The following placements are identical in both profiles:

| Element | Rectangle |
|---|---|
| bootstrap | `(68, 14, 24, 3)` |
| TL fiducial | `(7, 7, 9, 9)` |
| TR fiducial | `(144, 7, 9, 9)` |
| BR fiducial | `(144, 144, 9, 9)` |
| BL fiducial | `(7, 144, 9, 9)` |

The data cells contain the complete whitened coded stream with no spare cells.
They are filled row-major, left to right then top to bottom. Each byte consumes
four consecutive cells carrying bits `7..6`, `5..4`, `3..2`, `1..0`.

### Profile-specific rectangles

Timing rails and phase pilots are monochrome. Calibration entries are `2 × 2`
module swatches, ordered vertically as K, W, C, M, Y, G50.

| Profile | Data | Timing top / right / bottom / left | Phase top / bottom | Calibration left x / right x / y starts |
|---|---|---|---|---|
| ROBUST | `(44,37,72,85)` | `(44,36,72,1)` / `(116,37,1,85)` / `(44,122,72,1)` / `(43,37,1,85)` | `(78,34,4,1)` / `(78,124,4,1)` | `39` / `119` / `43,57,71,85,99,113` |
| EXPERIMENTAL | `(20,20,120,119)` | `(20,19,120,1)` / `(140,20,1,119)` / `(20,139,120,1)` / `(19,20,1,119)` | `(78,17,4,1)` / `(78,141,4,1)` | `15` / `143` / `28,48,68,88,108,128` |

On the top and left timing rails, even offsets are black and odd offsets are
white. The bottom and right rails are their complements. A phase pilot is four
modules containing the Gray-coded two-bit phase as `high, low, high, low`,
where black is 1 and white is 0. The top and bottom pilot values MUST agree.

### Frozen fiducials

Every fiducial is a 9 × 9 binary marker: a one-module black outer border, a
one-module white inner ring and one of these frozen 5 × 5 payloads (rows shown
top to bottom, black `1`, white `0`):

| ID | Payload rows |
|---|---|
| TL | `10111 / 01000 / 11011 / 11001 / 01101` |
| TR | `11101 / 11101 / 11100 / 10010 / 01010` |
| BR | `00001 / 11100 / 11110 / 01000 / 01100` |
| BL | `11100 / 00010 / 00010 / 10110 / 00010` |

Across all IDs and every 90-degree rotation, the minimum payload Hamming
distance is 10. The ID and its placement jointly determine orientation; a
receiver MUST NOT silently substitute or rotate these fixtures. A receiver
MAY correct at most four payload mismatches in each individual fiducial. The
limit is per marker, not a sum across the four markers; five or more mismatches
in any one marker require rejection even if the other three are exact.

### Bootstrap and calibration

The fixed 24×3 monochrome bootstrap encodes 16 data bits followed by CRC-8/ATM
(polynomial `0x07`, init/xorout 0). Data fields are magic `110101` (6 bits),
version (2), profile (3), palette (2), Gray-coded `sequence mod 4` (2), and a
zero reserved bit. Rows are word, complement, word. This wire representation
and its majority decoder are unchanged by the receiver policy described below.
Different upper and lower phase pilots mean a transition or rolling-shutter
capture and require early rejection.

The two calibration banks use, in order, K `#101010`, W `#FFFFFF`, C
`#00D8D8`, M `#D800D8`, Y `#D8D800` and G50 `#808080`. The same bank is used
for KRGB: R, G and B references are reconstructed from W−C, W−M and W−Y in the
classifier. Rasterizers MUST use integer pixels per logical module and disable
interpolation when presenting the canonical frame.

## Vision pipeline

The reference receiver performs three deterministic threshold passes, merges
geometrically equivalent quads, decodes orientation, estimates a homography
from all 16 oriented outer fiducial corners, and falls back to four fiducial
centres only when the 16-point primitive is unavailable. It then performs
the canonical warp with cubic interpolation, bootstrap validation,
calibration, Lab conversion, inset cell medians,
confidence classification, dewhitening, deinterleaving, RS correction and PDU
validation in that order. A single bounded refinement pass is permitted only
for a measurable, moderate initial residual and is retained only when it
materially reduces that residual. Confidence thresholds derive from
calibration-swatch MAD and are corpus-tuned, not wire constants. All temporary
`cv.Mat` and `ImageBitmap` objects must be released.

### Acquisition and temporal stability

Camera constraints and frame scheduling are reference-receiver policy, not
COLOR_4/1 wire constants. QR defaults to 1280-wide capture at 60 fps. COLOR_4
defaults to 1920 at 30 fps and exposes 15 fps plus a best-effort `max supported`
width. For a numeric COLOR_4 width, the receiver attempts exact selected
width/FPS, exact 1280/FPS fallback when different, and finally an ideal request.
`max supported` first opens 1280 safely and then applies the capability-reported
maximum width if the track accepts it. Requested and actual `getSettings()`
values are recorded separately; negotiation failure above 1280 is never a
protocol failure.

Before allocating the full-resolution capture, the reference receiver draws a
64×48 fingerprint. Each sample is rounded BT.709 luma:

```text
Y = round(0.2126 R + 0.7152 G + 0.0722 B)
```

For each of the 48 row-major 8×8 blocks `b`, consecutive fingerprints produce:

```text
blockMae[b] = sum(abs(Ycurrent - Yprevious)) / (64 * 255)
stabilityScore = nearestRankP90(blockMae[0..47])
stable = stabilityScore <= 0.025
```

The first observation is `warmup`. In `observe` mode all states remain eligible
for vision under the normal one-frame-in-flight rule and the result is telemetry
only. In `enabled` mode warmup and unstable captures are dropped before the
heavy path; only the first stable capture in a display interval is submitted,
except that a pending diagnostic snapshot may request another. This threshold
is an acquisition experiment constant and MUST NOT be interpreted as a PHY
compatibility boundary.

### Candidate ranking and optical diagnostics

Excess contours or quads no longer reject an otherwise usable camera frame
solely because a global proposal count was crossed. If a threshold pass returns
more than 50,000 contours, the receiver examines 50,000 uniformly distributed
indices and records `CONTOUR_BUDGET_UNIFORMLY_SAMPLED`. Cheap valid quads are
ranked before the 90×90 fiducial warp by:

```text
prewarpScore =
    0.5 * squareness
  + 0.3 * clamp(borderContrast / 96)
  + 0.2 * clamp(nestingDepth / 3)
```

Candidates are partitioned by 4-way x position, 4-way y position and 4-way
log-area band; only the best eight are retained per bucket. Cross-threshold
duplicates are merged and final ranking prefers threshold-pass support,
pre-warp score, nesting, contrast, square-ness and low corner spread before
keeping at most 256 expensive decodes. Truncation records
`CANDIDATE_BUDGET_RANKED`; it is a warning, not a rejection. The detector also
requires at least 30 luma levels of local fiducial contrast before Hamming
decode. This early detection gate is distinct from the 40-level canonical
black/white requirement below.

Once four oriented camera-stage fiducials exist, internal `VisionDiagnostics`
reports projective optical measurements. A homography from the four known
logical fiducial centres to their observed centres projects the four corners of
the complete 172-module frame. With projected corners TL/TR/BR/BL:

```text
apparentFrameWidthPx  = (distance(TL, TR) + distance(BL, BR)) / 2
apparentFrameHeightPx = (distance(TL, BL) + distance(TR, BR)) / 2
pixelsPerModuleX      = apparentFrameWidthPx / 172
pixelsPerModuleY      = apparentFrameHeightPx / 172
minimumPixelsPerModule = min(top, right, bottom, left) / 172
```

`fiducialWidthPx` and `fiducialHeightPx` are the weakest, across the four
markers, of each marker's mean opposing horizontal/vertical edges.
`fiducialContrast` is the weakest accepted local white-minus-black separation.
`blurMetric` is the weakest variance of the four-neighbour discrete Laplacian
inside a normalized 90×90 fiducial ROI. `clippedPixelFraction` is the fraction
in `[0,1]` of active-frame pixels whose three RGB channels are all at `<= 1` or
`>= 254` after canonical warping. The optical object is bridged into
`BrowserVisionDiagnostics`, so snapshots and experiment exports can report it;
clipping is absent until a canonical warp exists. For physical interpretation only, below
4 px/module is very poor, 4–5 risky, 5–6 borderline and at least 6 preferred;
these bands are warnings, not device-independent validity gates.

### Canonical validation

Canonical monochrome validation estimates black from the border and white from
the ring of each fiducial independently. Every local pair must be finite,
ordered and provide at least 40 luminance levels of contrast. Fiducials use
their own pair, and the quiet zone retains the spatial model interpolated from
the four marker centres. The four-error maximum remains per fiducial.

Bootstrap sampling is differential within each column. The reference receiver
forms a top vote from the sign of `Ymiddle - Ytop` and a bottom vote from the
sign of `Ymiddle - Ybottom`; a vote is reliable only when its absolute
difference is at least 16 luma levels. Two agreeing reliable votes, or one
reliable vote when the other is unavailable, decide the bit. Opposing reliable
votes and columns with no reliable vote are uncertain. Decided bits are then
expanded back to `word/complement/word` and passed to the unchanged bootstrap
majority/CRC/magic/reserved-bit decoder. The 16-level inclusive gate is a
receiver sampling policy, not a new PHY field or wire-format constraint.

Each timing rail supplies its own mandatory local black/white model. Samples
are split by the rail's expected alternating bit, black and white are their
respective medians, and `white - black` must be at least 40 luma levels. A
valid model classifies timing modules with the existing normalized 0.35/0.65
deadband. An invalid, flat or inverted model makes the complete rail uncertain
and rejects before phase decoding. The existing global 8% timing-error limit
continues to apply across all 314 ROBUST or 478 EXPERIMENTAL timing modules;
there is no per-rail error allowance. Top and bottom phase pilots use the top
and bottom rail models respectively and must still decode to the same phase.
These differential and per-rail models are receiver photometric policy; the
transmitted timing and pilot patterns remain unchanged.

Quiet-zone validation samples eight positions per side halfway through the
six-module white band, rather than relying on the extrapolated outer corners.
Each channel is normalized against the spatially interpolated RGB border/ring
response and must reach the unchanged 0.65 white threshold; brightness alone
cannot make a saturated colour count as white. At most two of the 32
distributed samples may be non-white or uncertain. This is a receiver
fail-closed policy: a missing, dark or coloured side still rejects while
isolated contamination at an extreme canonical corner cannot decide a frame.

### Internal rejection localization

The browser may attach an optional `diagnosticReason` after rejection:

```text
CANONICAL_DIMENSIONS
FIDUCIAL_CANONICAL
QUIET_ZONE_LUMA
QUIET_ZONE_RGB
TIMING
BOOTSTRAP
PHASE
CALIBRATION
COLOR_CLASSIFICATION_TOO_UNCERTAIN
RS_FAILED
CRC_FAILED
```

This is additive, browser-only diagnostics. It is not serialized in COLOR_4,
does not replace the lower-level `rejectReason`, and MUST NOT make a rejected
frame eligible for the fountain decoder. Early contour, fiducial-detection and
homography failures can remain expressed by their existing vision reject reason
without a second `diagnosticReason`.

Classifier diagnostics may additionally report bootstrap vote counts and
differential margins, the number of uncertain timing modules, and each local
rail's median black, median white, threshold, contrast and error counts. These
values are diagnostic receiver observations only. Bootstrap bytes may appear
in an explicitly detailed in-memory observation after all 24 columns are
decided, but are not persisted in experiment history and do not alter any
acceptance rule.

Real-camera fixtures and repeated A–E hardware runs remain an external release
gate, not normative protocol vectors. Synthetic/corpus/E2E success alone cannot
establish physical acquisition success. See
[benchmarking](benchmarking.md) and the [Debug Vision capture protocol](../user/debug-vision.md).

A canonical-warp replay may pin bootstrap, timing, phase, classification and RS
behavior independently of acquisition, OpenCV detection and homography. The
`capture-000017` canonical fixture deliberately proves both contracts: a direct
core unwrap with all 195 classifier erasures remains `fec-uncorrectable`, while
the bounded receiver policy selects 55 FEC-feasible erasures and reaches valid
RS, CRC32C and wire validation. Its recovered inner hash is a CRC-derived
regression oracle, not independent transmitter ground truth or evidence of a
successful physical end-to-end transfer.

## Security and resource limits

COLOR_4 is not encrypted or authenticated. Any camera can record it. Receivers
MUST validate all fixed sizes and profile bounds before allocating from
untrusted headers. Active equations and reconstructed content live only in RAM;
reload or mode change cancels them.
