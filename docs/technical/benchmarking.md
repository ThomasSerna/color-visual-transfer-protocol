# QR versus COLOR_4 benchmark

COLOR_4 is accepted on correctness and reproducibility; it is not required to
outperform QR.

## Controlled comparison

Use the same incompressible pseudo-random 1 MiB file, displayed area, sending
screen, receiving camera, negotiated resolution/FPS, brightness, distance,
angle and lighting for both carriers. Record the actual camera settings rather
than requested constraints. Run each condition three times and publish the
median and spread, not only the best run.

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
raw and merged candidates, the configured threshold passes, rejection stage, uncertain
cells/bytes, the per-attempt erasure-byte distribution (including p50/p95), RS
corrections, CRC failures, fiducial errors by marker and maximum, homography
method and residual, refinement attempts/applied, valid/new/duplicate LT
frames, resolved blocks, decode latency, elapsed time and negotiated camera
settings.

The base homography-fit residual and the optional refinement residuals before
and after correction are separate distributions; do not combine them into one
percentile series.

Report both:

- **container goodput:** recovered DCF2 bytes divided by elapsed time;
- **file goodput:** original verified file bytes divided by elapsed time.

Compression must be disabled by using incompressible input or explicitly
reported. The original Decimen 128 KB/s observation is not a COLOR_4 baseline
unless reproduced under this method.

For the frozen first receiver run, diagnostic ZIP contents and the subsequent
1/2/5/10 fps by 960/1280/1920 by 0.3/0.5/1 m matrix, follow
[Debug Vision](../user/debug-vision.md). Treat the ZIP as sensitive camera data.

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

## Frozen physical baseline

Before claiming a physical fix, send a small deterministic file in fullscreen
at maximum display brightness using COLOR_4 ROBUST, K/C/M/Y palette and 5 fps.
Receive at 0.5 m, frontal (0°), under normal indoor light with 1280 capture and
detection plus canonical scale 6. Run for 60 seconds three times. Preserve the
metrics JSON for every run and compare the recovered SHA-256 with the source.
All three runs must complete with the exact hash and zero accepted corrupt
frames. Scale 8 is a documented fallback only if scale 6 produces no valid
frames and scale 8 succeeds consistently in the same three-run protocol; it
must not silently replace the default.

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
