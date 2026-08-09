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
shows capture/decode fps, goodput, elapsed time, new/duplicate frames, K, block
length, accepted/rejected carrier frames and RS corrections/erasures.

**Export measurements** downloads JSON containing the current run and stored
history. Each summary includes negotiated camera resolution/fps, captures,
busy-worker skips, candidates, geometry/bootstrap/calibration rejections,
uncertain cells, RS corrections/failures, CRC failures, valid/new/duplicate
frames, solved blocks, decode-latency statistics, container bitrate and file
goodput when available. **Clear history** deletes these summaries but not app
preferences. Use this export for paired QR/COLOR_4 benchmark runs.

## Receive settings

Width and capture fps are applied live where the camera permits it. The fps
picker follows the carrier default until you choose a rate manually; that
manual choice then remains in force for the page session. If a device refuses
reconfiguration, the current stream continues and the UI reports that a restart
is needed. The line below the controls reports the actually negotiated camera
settings.

| Setting | Default | Notes |
|---|---:|---|
| capture width | 1280 | 1920 adds sampling cost; 960 can help weak CPUs |
| QR capture fps | 60 | unsupported rates are disabled; some devices negotiate 30 |
| COLOR_4 capture fps | 30 | lowers vision-worker pressure and camera motion artifacts |
| QR decode workers | 2 | independent ZXing workers; busy workers discard captures |
| COLOR_4 palette | KCMY | must match the sender; KRGB is Labs only |

COLOR_4 uses one OpenCV vision worker and keeps only one image in flight. If it
is busy, the next capture is deliberately discarded; this protects latency and
memory, and the fountain layer absorbs the loss.

For stage-by-stage overlays, a one-frame diagnostic ZIP and the reproducible
60-second physical baseline, see [Debug Vision](debug-vision.md). Debug snapshots
contain a real camera image and should be reviewed before sharing.
