# Capturing a signal

Open `/receive/` and explicitly select the carrier shown by the sender:

- **QR compatible** decodes the original Decimen QR stream.
- **COLOR_4** loads the colour-vision worker. Select the sender's KCMY or KRGB
  palette before starting; the profile itself is identified by the bootstrap.

Tap **Start camera** and point it at the complete frame, including its white
quiet zone. There is no pairing and no start frame: the receiver can lock onto
an already-running fountain stream and discovers file versus text from the
verified inner container. Switching carrier or COLOR_4 palette cancels the
current in-memory session and requires **Start camera** again.

Fill most of the camera view with the frame and steady both devices. Continuous
focus, exposure and white balance are requested independently where the camera
supports each mode. The MVP physical-acceptance target for COLOR_4 is
ROBUST/KCMY at 0.5–1 m and up to 15°; KRGB and EXPERIMENTAL are laboratory modes.

Progress counts collected fountain frames, not only solved blocks. Peeling can
resolve many blocks late in the run, so only SHA-256-verified completion reaches
100%.

## When it lands

- The complete DCF2 container and file SHA-256 are checked before the result is
  offered.
- Images, video and audio preview inline; other files expose a **Save** link.
- **Capture another transfer** starts with a fresh receiver.
- **Clear received media** removes staged received media; see [Privacy](privacy.md).
- Text snippets have a **Copy** button and disappear when the tab closes.

Reloading or closing the page loses the active session, fountain equations and
reconstructed bytes. IndexedDB contains only preferences and bounded experiment
summaries, never transfer contents.

## Diagnostics and measurement export

**Live diagnostics** becomes **Transfer summary** when reception stops. It
shows capture/decode fps, distinct **new blocks/s**, goodput, elapsed time,
new/duplicate frames, K, block length, accepted/rejected carrier frames and RS
corrections/erasures. Decode fps counts completed attempts; new blocks/s is the
useful distinct-frame rate and is measured between the first and last new frame.

**Export measurements** downloads JSON containing the current run and stored
history. Each summary includes negotiated camera resolution/fps, captures,
busy-worker skips, candidates, geometry/bootstrap/calibration rejections,
uncertain cells, RS corrections/failures, CRC failures, valid/new/duplicate
frames, solved blocks, decode-latency statistics, container bitrate and file
goodput when available. COLOR_4 runs additionally record stability warmup,
stable/unstable captures, vision submissions, unstable/redundant-stable skips
and the bounded normalized stability-score distribution. Schema-v2 summaries
can also include bitmap/RGBA capture counts, reservations and whitelisted drop
causes, cold/tracked/fallback/legacy/transition counts, legacy probes and holds,
worker counts/restarts/utilization, bounded
tracking/sampling/guard/classifier timings, tracking-gate distributions,
distinct-frame rate and estimated pipeline capacity. Existing schema-v1 history is exported unchanged alongside
new runs. **Clear history** deletes these summaries but not app preferences. Use
this export for paired QR/COLOR_4 benchmark runs.

## Receive settings

Width and capture fps are applied live where the camera permits it. Each
carrier has its own default and remembers its own manual choices for the page
session. If a device refuses reconfiguration, the current stream continues and
the UI reports that a restart is needed. The line below the controls reports
the actually negotiated camera settings; those values, rather than the request,
are authoritative.

| Setting | Default | Notes |
|---|---:|---|
| QR capture width | 1280 | selectable 960, 1280 or 1920 |
| COLOR_4 capture width | 1920 | selectable 960, 1280, 1920 or **max supported** |
| QR capture fps | 60 | unsupported rates are disabled; some devices negotiate 30 |
| COLOR_4 capture fps | 30 | selectable 15 or 30; resolution and stability take priority over 60 |
| QR decode workers | 2 | independent ZXing workers; busy workers discard captures |
| COLOR_4 classifier workers | 2 | selectable 1–3; OpenCV geometry remains a single temporal worker |
| COLOR_4 palette | KCMY | must match the sender; KRGB is Labs only |

For a numeric COLOR_4 width, startup first requests that width and FPS exactly.
If it is unavailable, the receiver tries 1280 at the requested FPS, then a
non-fatal ideal request for the originally selected width. **max supported**
opens a safe 1280 stream and then best-effort applies the maximum width reported
by camera capabilities. A failed maximum upgrade is not fatal. Camera height
remains an ideal 4:3 hint because not every sensor exposes that shape at every
width.

COLOR_4 uses one stateful OpenCV geometry worker feeding two lightweight
classifier/FEC workers by default. A capture reserves geometry and one
classifier slot before any prefilter or bitmap allocation. There is no queued
camera frame: if either stage lacks capacity, the new callback is deliberately
discarded, protecting latency and memory while the fountain layer absorbs loss.

If the temporal path rejects three non-transition frames in a row, the receiver
spends one capture on the legacy full-warp pipeline. When that capture decodes,
legacy holds for a bounded run and the temporal path then resumes from a fresh
acquisition; repeats lengthen the hold up to a cap and a sustained good run
clears it. The receiver never abandons the temporal path for a whole session.

Before that worker, COLOR_4 measures motion using a 64×48 BT.709-luma
fingerprint. It compares 8×8 blocks, uses normalized p90 mean absolute error,
and treats scores at or below `0.025` as stable. The default **observe
(shadow)** mode records the decision without dropping captures. **enabled**
skips warmup/unstable captures and submits only the first stable capture after
each detected transition. This is an experimental receiver policy, not a wire
protocol relaxation.

For stage-by-stage overlays, the exact-RAW diagnostic ZIP and the reproducible
A–E physical protocol, see [Debug Vision](debug-vision.md). Snapshot JSON records
requested/actual camera settings and SHA-256 of the pre-processing RGBA bytes.
Debug snapshots contain a real camera image and should be reviewed before
sharing.
