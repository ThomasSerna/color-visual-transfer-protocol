# QR versus COLOR_4 benchmark

COLOR_4 is accepted on correctness and reproducibility; it is not required to
outperform QR.

## Controlled comparison

Use the same incompressible pseudo-random 1 MiB file, displayed area, sending
screen, receiving camera, negotiated resolution/FPS, brightness, distance,
angle and lighting for both carriers. Record the actual camera settings rather
than requested constraints. QR defaults to 1280@60 while COLOR_4 defaults to
1920@30, so a direct carrier comparison must override them to the same actual
capture mode; the COLOR_4-only A–E acquisition matrix below intentionally does
not. Run each condition three times and publish the median and spread, not only
the best run.

The ROBUST acceptance matrix is:

| Distance | Angle | Lighting | Repetitions |
|---:|---:|---|---:|
| 0.5 m | 0° | normal indoor | 3 |
| 0.5 m | 15° | normal indoor | 3 |
| 1.0 m | 0° | normal indoor | 3 |
| 1.0 m | 15° | normal indoor | 3 |

Every run must reconstruct bytes with the expected SHA-256. A failed or
aborted run remains in the report.

## Required fields

Export the application metrics JSON plus device/browser/build identifiers and
physical conditions. At minimum report captures, frames skipped while busy,
stability warmup/stable/unstable captures, stability-score distribution, vision
submissions, unstable/redundant-stable skips, raw/ranked/merged candidates,
candidate-budget warnings, configured threshold passes, rejection stage and
internal `diagnosticReason` when present, uncertain cells/bytes, aggregate
candidate-score count/min/p50/p95/max, selected erasure policy/budget/per-shard
cap and counts, aggregate attempt count, and each positional attempt's
policy/status/phase, budget, erasure distribution, duration and whitelisted
rejection reason. Candidate indices, full ranked lists, coded bytes and payload
must not appear in an experiment export. Also report RS corrections, CRC failures,
fiducial errors by marker and maximum, homography method and residual,
refinement attempts/applied, valid/new/duplicate LT frames, resolved blocks,
decode latency, elapsed time and requested plus negotiated camera settings.

When all four camera-stage fiducials are available, also report apparent frame
width/height, pixels/module x/y and minimum, weakest fiducial width/height and
contrast, weakest fiducial-ROI Laplacian variance, and worst clipped-pixel
fraction. These optical metrics are exported through browser vision diagnostics
when available and use the formulas in the
[COLOR_4 vision specification](color4-protocol.md#candidate-ranking-and-optical-diagnostics).

The base homography-fit residual and the optional refinement residuals before
and after correction are separate distributions; do not combine them into one
percentile series.

Report both:

- **container goodput:** recovered DCF2 bytes divided by elapsed time;
- **file goodput:** original verified file bytes divided by elapsed time.

Compression must be disabled by using incompressible input or explicitly
reported. The original Decimen 128 KB/s observation is not a COLOR_4 baseline
unless reproduced under this method.

For the frozen capture-first runs, diagnostic ZIP contents and the subsequent
1/2/5/10 fps by 960/1280/1920 by 0.3/0.5/1 m matrix, follow
[Debug Vision](../user/debug-vision.md). Treat the ZIP as sensitive camera data.

## Physical A–E acquisition matrix

Freeze the sender at COLOR_4 ROBUST, KCMY, 5 fps, fullscreen and maximum display
brightness. Fix the devices at 0.5 m, frontal, under unchanged indoor light;
use detection limit 1280. Run every row for at least 60 seconds and up to 180
seconds when needed to collect 300 vision submissions:

| Variant | Requested capture | Prefilter | Canonical scale |
|---|---|---|---:|
| A | 1280 @ 30 | observe | 6 |
| B | 1920 @ 30 | observe | 6 |
| C | 1920 @ 15 | observe | 6 |
| D | 1920 @ 30 | enabled | 6 |
| E | 1920 @ 30 | enabled | 8 |

Repeat the complete matrix three times without moving the devices. Preserve an
exact-RAW diagnostic ZIP and experiment JSON for every variant, including
failed and aborted runs. Compare valid-frame rate, stage/reason distribution,
stability/submission ratios, worker p50/p95 and optical metrics. A request that
negotiates another width/FPS is not equivalent to the named variant; retain the
run as evidence but label it with the actual mode.

## Real-capture replay gate

Physical A–E runs remain a manual external gate until privacy-reviewed fixtures
with metadata and explicit expected outcomes are checked into
`tests/fixtures/color4/physical/`. Never commit an accidental room/person image.
A cropped or anonymized fixture must declare that transformation because it no
longer preserves full-frame coverage or background candidate load. Passing the
synthetic corpus, fake-camera E2E or a local replay cannot replace three
repeatable real-device runs for a 256 KiB pseudo-random file plus three for a
separate 1 MiB file. All six must reach `Signal recovered`, match bytes and
SHA-256, progress `newFrames` and `resolvedBlocks` to K, and admit no frame to
the fountain decoder before every carrier validation passes.

## Synthetic and soak gates

Before physical claims, run the frozen corpus over all four rotations,
perspective to ±15°, blur, noise, gamma, exposure, white balance, spatially
varying luminance/black level, JPEG/4:2:0, partial glare and mixed-transition
frames. Uncertainty must result in correction or rejection, never an accepted
corrupt LT frame.

Run a sustained camera/worker soak and verify that heap use, WASM handles and
object URLs do not grow without bound. The EXPERIMENTAL profile remains Labs
until it independently passes the same gates.

The reproducible local gates are:

```text
npm run test:color4
npm run test:color4:corpus
npm run test:e2e:color4
```

The required synthetic corpus must be byte-exact at 960, 1280 and 1920 input
sizes; all four rotations; perspective through ±15°; a roughly 480 px frame;
4:2:0 colour loss; mild blur, exposure, noise, radial distortion and glare; a
required corner-dependent luminance/black-level field; and frozen combined
degradations that pair that field with blur and 4:2:0. Deliberately extreme
inputs may either decode byte-exactly or reject, but may never produce accepted
corrupt bytes. Blank, black, random and structurally invalid inputs must reject.

## Physical success decision

The A–E matrix first localizes acquisition and worker effects; it does not by
itself prove file transfer. Before claiming a physical fix, use its best
repeatable scale-6 configuration to reconstruct the same deterministic file in
three consecutive runs. Every run must complete with the expected file SHA-256
and zero accepted corrupt frames. Variant E/scale 8 is a documented diagnostic
fallback only: it must not silently replace scale 6 or the default configuration.

If none of A–E yields repeatable valid frames, report the dominant measured
failure instead of relaxing Hamming, RS, CRC or classification uncertainty.
Insufficient pixels/module under an actually negotiated high-resolution,
well-focused setup is evidence for evaluating a less dense future PHY; detector,
geometry or calibration-dominant failures are not.

## Opt-in 64 MiB pipeline stress

`npm run test:stress` is intentionally excluded from the normal unit-test glob.
It allocates a deterministic 64 MiB file, uses maximal UTF-8 name and media-type
fields, packs and hashes the maximum legal DCF2 container, and streams complete
EXPERIMENTAL-profile LT equations through `packFrame`, `parseFrame` and
`LTDecoder`. Completion is accepted only after container FNV-1a, DCF2 unpacking
and SHA-256 verification succeed.

The test prints a single `STRESS_METRICS` JSON record with source blocks,
accepted-frame overhead, phase timings and sampled process RSS. RSS is a
coarse process-level high-water sample, not a browser heap measurement. This
test does not exercise camera capture, OpenCV/WASM handles, optical distortion
or object-URL lifetime, so a sustained physical browser soak remains a separate
release gate.
