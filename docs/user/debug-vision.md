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

The advanced controls select canonical scale 4, 6 or 8 and a detection limit of
960, 1280 or the source resolution. They, along with the declared run
conditions, are locked once reception starts. Stop and begin a fresh session to
change them; mixing configurations inside one experiment would make the result
ambiguous.

Live metrics identify the last completed stage and rejection reason, detected
fiducials, and worker p50/p95 timing. The exported experiment JSON keeps bounded
histograms and timing reservoirs, not an unbounded frame log.

## Capture a diagnostic ZIP

While a COLOR_4 reception is active, select **Capture debug snapshot**. The
button arms the next free camera capture; it does not interrupt the one-frame-
in-flight rule. A single ZIP is downloaded with a zero-padded capture ID:

```text
capture-000123-raw.png
capture-000123-threshold.png
capture-000123-warped.png    # only when homography succeeded
capture-000123.json
```

The JSON says `warped.available=false` when the warped PNG is legitimately
absent. It also contains the frame diagnosis, bounded candidate/fiducial/
calibration traces, accumulated experiment metrics, effective debug settings,
build label, browser identifier and the physical conditions entered in the
panel. The ZIP uses uncompressed STORE entries because PNG is already
compressed; each entry is protected by the standard ZIP IEEE CRC-32.

The application does not put snapshot images, per-frame traces or coordinates
in IndexedDB. Pixel buffers, blobs and temporary object URLs are released after
download or cancellation. The downloaded ZIP remains in the browser's download
folder until you delete it.

> **Privacy warning:** the raw PNG is a real camera image. It can include people,
> screens, reflections, documents and surroundings outside the transmitted
> frame. Inspect the ZIP before sharing it and use a controlled scene for tests.

## Frozen first physical baseline

Use this run before changing thresholds or tuning more than one stage. Its goal
is to locate the dominant failure, not to prove throughput.

1. On the transmitter select **COLOR_4**, **ROBUST**, **KCMY**, **5 fps** and
   fullscreen. Use high/max display brightness.
2. On the receiver select capture width **1280**, enable Debug Vision, choose
   canonical scale **4** and detection limit **960**, then enter TX FPS 5,
   distance 0.5 m, angle 0 degrees,
   brightness and a unique run label.
3. Fix the phone in place about **0.5 m** from the display, nearly square-on
   (approximately **0 degrees**) under normal indoor lighting. Keep the complete
   white quiet zone visible.
4. Start reception. Run for at least **60 seconds** and until **300 processed
   attempts** have been observed, with a hard maximum of **180 seconds**.
5. Arm one debug snapshot near the end of the run. Keep the downloaded ZIP and
   also use **Export measurements** for the experiment history.

Record the actual negotiated camera resolution and FPS shown by the receiver,
not only the requested values. Do not alter the palette, profile, scale,
detection limit, distance or angle during the run.

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

## Follow-up matrix

After valid frames are observed in three baseline sessions, reconstruct the
same incompressible pseudo-random 1 MiB file with a verified SHA-256 in three of
three runs. Then run every combination below while holding the remaining
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
