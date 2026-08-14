# Debug Vision and physical capture bundles

Debug Vision is an opt-in COLOR_4 diagnostic panel in the installed or hosted
PWA receiver. It is off by default and is not included in either QR-only
standalone HTML file. It instruments the optical carrier only: DCF2, fountain
LT, Reed-Solomon limits, CRC checks and accepted frame bytes are unchanged.

## What the panel shows

Enable **Debug Vision** before starting a COLOR_4 reception. The panel offers
one view at a time:

- **Raw**: the camera pixels supplied to the worker.
- **Grayscale**: the luminance image used for marker detection.
- **Threshold**: the binary image used to find contours.
- **Contours**: candidate quadrilaterals and filter results.
- **Fiducials**: decoded TL/TR/BR/BL IDs and Hamming errors.
- **Warped**: the canonical frame after a successful homography.
- **Calibration**: the warped frame with calibration-bank locations.

The overlay above the live preview maps candidate quads, centres, IDs and error
counts through the preview's actual `object-fit: cover` crop. It is a sibling
canvas; the camera video itself is not filtered or transformed. The selected
stage canvas is updated at no more than two frames per second so diagnostics do
not become the main decoding workload.

Each bounded candidate trace records its primary threshold pass, support across
all three passes and deterministic candidate score. The cheap pre-warp score
combines square-ness, border contrast and contour nesting; it ranks work but is
not by itself a validity decision. These per-frame details stay in the opt-in
debug snapshot rather than the persisted experiment history.

The advanced controls select canonical scale 4, 6 or 8 (default 6) and a
detection limit of 960, 1280 (default) or the source resolution. They, along
with the declared run conditions, are locked once reception starts. Stop and
begin a fresh session to change them; mixing configurations inside one
experiment would make the result ambiguous.

The panel also selects the temporal prefilter mode. **observe (shadow)** is the
default: it measures every capture but does not drop one for instability.
**enabled** enforces the stable-frame decision described below. The mode is
locked for the run and is included in its exported conditions.

Live metrics identify the last completed stage and rejection reason, detected
fiducials, and worker p50/p95 timing. The exported experiment JSON keeps bounded
histograms and timing reservoirs, not an unbounded frame log. COLOR_4 summaries
also include warmup/stable/unstable captures, vision submissions, unstable and
redundant-stable skips, and the bounded stability-score distribution.

The classifier may also attach optional binary-structure diagnostics: bootstrap
double/single/uncertain/contradictory vote counts and differential margins, plus
per-rail black/white medians, threshold, contrast, errors and uncertain module
counts. They explain why bootstrap, timing or phase passed or failed; they are
not new live panel views and do not change the PHY. Experiment exports may keep
bounded numeric distributions for these values, but never the decoded bootstrap
bytes. Detailed bytes, when requested, exist only in the per-frame in-memory
debug observation after all 24 bootstrap columns were decided.

After colour classification completes, its optional aggregate diagnostics split
uncertain cells into distance, nearest-colour gap and overlapping causes. They
also report erasure hints per Reed-Solomon shard, parity and remaining budget,
uncertainty counts by canonical row and column, the effective thresholds, and
`count/min/p50/p95/max` summaries for best-colour distance and colour gap. The
arrays contain only counts; erased-byte positions and payload bytes are not
included. Persisted experiments keep a bounded whitelist of these aggregates
and reset profile-shaped series if the detected COLOR_4 profile changes.

Receiver diagnostics can additionally include the selected `erasurePolicy`,
the original `suggestedErasuresByShard`, saturated shards and at most two
ordered `unwrapAttempts`. `erasureBytes` remains the number of optical hints,
while `erasures` and correction counters describe the selected attempt. Stage
timings include every attempted unwrap; RS/CRC failure counters describe the
final selected outcome, so a frame rescued by hard decision is not reported as
failed. These fields are optional so older snapshots remain readable.

## Capture a diagnostic ZIP

While a COLOR_4 reception is active, select **Capture raw camera frame +
diagnostics**. This action remains available when live Debug Vision is off. The
button arms the next eligible free camera capture; it does not interrupt the
one-frame-in-flight rule. A single ZIP is downloaded with a zero-padded capture
ID:

```text
capture-000123-raw.png
capture-000123-threshold.png
capture-000123-warped.png    # only when homography succeeded
capture-000123.json
```

The JSON says `warped.available=false` when the warped PNG is legitimately
absent. Its version-1 record also contains:

- carrier, palette, expected and observed profile, declared transmitter FPS,
  canonical scale, detection limit and prefilter mode;
- requested camera width/height/FPS alongside the authoritative negotiated
  values from `MediaStreamTrack.getSettings()`;
- raw width, height, RGBA row stride (`width * 4`) and `rgbaSha256`;
- frame diagnosis, bounded candidate/fiducial/calibration traces, accumulated
  experiment metrics, build label, browser identifier and declared physical
  conditions.

`rgbaSha256` hashes the exact row-major RGBA bytes supplied to the worker before
grayscale conversion, detection resize, thresholding, homography or colour
normalization. It is not a hash of the PNG container and is unrelated to the
SHA-256 of a transferred file. The PNG is the lossless, shareable rendering of
that plane. The ZIP uses uncompressed STORE entries because PNG is already
compressed; each entry is protected separately by the standard ZIP IEEE
CRC-32.

The application does not put snapshot images, per-frame traces or coordinates
in IndexedDB. Pixel buffers, blobs and temporary object URLs are released after
download or cancellation. The downloaded ZIP remains in the browser's download
folder until you delete it.

> **Privacy warning:** the raw PNG is a real camera image. It can include people,
> screens, reflections, documents and surroundings outside the transmitted
> frame. Inspect the ZIP before sharing it and use a controlled scene for tests.

## Temporal stability score

For every COLOR_4 camera callback, the receiver first draws a cheap 64×48
fingerprint and converts it to rounded BT.709 luma:

```text
Y = round(0.2126 R + 0.7152 G + 0.0722 B)
```

It divides the fingerprint into 48 row-major 8×8 blocks. Each block score is
its mean absolute luma difference from the preceding fingerprint divided by
255; the frame score is the nearest-rank p90 of those block scores. A score at
or below `0.025` is stable.

- The first capture after start/reset is `warmup` because it has no predecessor.
- In `observe`, warmup, stable and unstable captures remain eligible for vision
  (the normal one-frame-in-flight rule still applies); the decision is
  telemetry only.
- In `enabled`, warmup and unstable captures stop before the full-resolution
  canvas/worker path. The first stable capture after a transition is submitted;
  later stable captures in the same interval are skipped unless a diagnostic
  snapshot is pending.

This is receiver acquisition policy, not a COLOR_4 wire constant. Keep
`observe` when collecting a neutral baseline and compare it with `enabled`
under the same physical setup.

## Frozen capture-first physical protocol

Use this protocol before changing thresholds or tuning more than one stage. Its
goal is to locate the dominant failure, not to prove throughput.

1. On the transmitter select **COLOR_4**, **ROBUST**, **KCMY**, **5 fps** and
   fullscreen. Use high/max display brightness.
2. On the receiver enable Debug Vision, keep detection limit **1280**, then
   enter expected profile ROBUST, TX FPS 5, distance 0.5 m, angle 0 degrees,
   brightness and a unique run label.
3. Fix the phone in place about **0.5 m** from the display, nearly square-on
   (approximately **0 degrees**) under normal indoor lighting. Keep the complete
   white quiet zone visible.
4. Run each A–E variant below for at least **60 seconds**. When a run targets
   processed attempts, continue until **300 vision submissions** or a hard
   maximum of **180 seconds**.
5. Arm one debug snapshot near the end of the run. Keep the downloaded ZIP and
   also use **Export measurements** for the experiment history.

The variants are cumulative only where the table says so; all unspecified
settings remain frozen:

| Variant | Capture | Prefilter | Canonical scale |
|---|---|---|---:|
| A | 1280 @ 30 | observe | 6 |
| B | 1920 @ 30 | observe | 6 |
| C | 1920 @ 15 | observe | 6 |
| D | 1920 @ 30 | enabled | 6 |
| E | 1920 @ 30 | enabled | 8 |

Record the actual negotiated camera resolution and FPS shown by the receiver,
not only the requested values. For every variant retain captures,
warmup/stable/unstable counts, vision submissions, valid frames, dominant
fiducial/geometry/calibration/RS rejection, worker p50/p95 and the optical
metrics when four fiducials were available. Do not alter palette, profile,
detection limit, distance, angle, display size or lighting during the matrix.
Run all variants three times before treating a difference as repeatable.

## Sharing the bundle for diagnosis

Share the ZIP unchanged, plus the exported `cvtp-experiments-*.json` when it is
available. In the accompanying message state:

- transmitter and receiver device models;
- operating system and browser versions;
- CVTP build label;
- display brightness and room lighting;
- whether the devices were fixed or handheld;
- the run label and any departure from the frozen baseline.

The ZIP already contains the declared conditions, but the short human note is
useful for spotting an incorrectly selected setting. Do not post a raw-camera
bundle publicly unless its contents are safe to disclose.

Diagnosis chooses the first stage with more than 40% of exclusive rejections.
If no stage crosses 40%, compare the first two stages, but change only one
variable at a time. Never relax CRC or the Reed-Solomon correction bound to make
a frame appear valid. A proposed change is kept only when the exact baseline
produces more valid frames without CRC failures or incorrect inner frames.

For the bounded-policy receiver check, run three additional controlled captures
with ROBUST, KCMY, 5 fps, canonical scale 6, detection limit 1280 and prefilter
`observe`. Each run must contain at least one frame that completes bootstrap,
timing and phase and then passes RS, CRC32C, outer/inner validation and identity
through the receiver's bounded erasure policy. A direct decode with all optical
erasure hints may still reject; that preserves the core decoder contract and is
not the receiver outcome. A frame that merely reaches RS but fails the remaining
gates is not successful.

## Real-capture gate and fixture privacy

The A–E runs and their unmodified ZIP/experiment exports remain an external
hardware gate. Unit, corpus and fake-camera E2E tests do not satisfy it. A real
camera fixture may enter `tests/fixtures/color4/physical/` only after privacy
review, with controlled or anonymized imagery, its metadata and an explicit
expected result. Cropping changes apparent resolution and candidate load, so a
crop is not interchangeable with the original full-camera replay and must be
identified as such. Before a capture passes that review, preserve its original
outside the repository and report the physical run separately. The reviewed
`capture-000017` full frame is now retained as a CRC-derived physical regression,
but release acceptance still requires a new controlled fixture whose expected
inner bytes were recorded independently at the transmitter.

A privacy-reviewed `warped.png` may instead enter
`tests/fixtures/color4/canonical/` without its raw camera counterpart. It must
pin both the PNG and decoded-RGBA hashes and explicitly identify itself as a
canonical-boundary replay. It can verify bootstrap, timing, phase, calibration,
classification and RS behavior, but cannot support claims about camera input,
OpenCV contours/fiducials, homography, or physical end-to-end success.

## Follow-up matrix

After valid frames are observed repeatedly in the A–E protocol, reconstruct the
same incompressible pseudo-random 1 MiB file with a verified file SHA-256 in
three of three runs. Then run every combination below while holding the winning
baseline conditions fixed:

| Dimension | Values |
|---|---|
| Transmitter FPS | 1, 2, 5, 10 |
| Requested capture width | 960, 1280, 1920 |
| Distance | 0.3 m, 0.5 m, 1.0 m |

This is 36 conditions before repetitions. Keep unsuccessful and aborted runs,
report the negotiated camera settings, and compare medians and dispersion. The
separate ROBUST acceptance matrix still covers 0 and 15 degree angles. A
synthetic pass or a single snapshot is not evidence that the physical receiver
is fixed; that claim requires the repeated hardware runs and SHA-256 results.
