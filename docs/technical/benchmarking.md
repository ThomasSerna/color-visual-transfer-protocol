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
candidates, rejection stage, uncertain cells/bytes, RS corrections, CRC
failures, valid/new/duplicate LT frames, resolved blocks, decode latency,
elapsed time and negotiated camera settings.

Report both:

- **container goodput:** recovered DCF2 bytes divided by elapsed time;
- **file goodput:** original verified file bytes divided by elapsed time.

Compression must be disabled by using incompressible input or explicitly
reported. The original Decimen 128 KB/s observation is not a COLOR_4 baseline
unless reproduced under this method.

## Synthetic and soak gates

Before physical claims, run the frozen corpus over all four rotations,
perspective to ±15°, blur, noise, gamma, exposure, white balance, JPEG/4:2:0,
partial glare and mixed-transition frames. Uncertainty must result in correction
or rejection, never an accepted corrupt LT frame.

Run a sustained camera/worker soak and verify that heap use, WASM handles and
object URLs do not grow without bound. The EXPERIMENTAL profile remains Labs
until it independently passes the same gates.

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
