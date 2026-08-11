# Physical COLOR_4 replay fixtures

This directory is intentionally a scaffold. It contains no fabricated camera
capture. A fixture belongs here only when its pixels came from a real camera
viewing a real transmitting display.

Create one subdirectory per controlled capture:

```text
physical/
  lab-phone-a-001/
    raw-frame.png
    metadata.json
```

`raw-frame.png` is decoded to 8-bit RGBA by `pngjs`. The test hashes that RGBA
plane—not the compressed PNG file—and compares it with
`rawFrame.rgbaSha256`. This catches accidental recompression, cropping or pixel
edits. If privacy requires changing the export, set `rawFrame.preparation` to
`privacy-crop` or `privacy-redacted`, then calculate the hash from the final
checked-in PNG. Those preparations must also set `rawFrame.scope` to
`limited-evidence`. A limited fixture is still useful for deterministic decode
regressions, but it cannot support claims about whole-frame acquisition or the
candidate budget because the removed/changed scene may have contained competing
contours. Only an unaltered `full-camera-frame` fixture can cover those claims.
For that scope, the PNG width and height must equal `camera.actual`; a limited
fixture may differ because of its documented preparation.

`metadata.json` must reference `../metadata.schema.json` and follow that schema.
It records:

- an explicit `physical-camera` provenance attestation;
- final PNG dimensions and RGBA hash;
- requested and actual negotiated camera width, height and FPS, plus the
  physical setup (actual `getSettings()` values remain authoritative);
- the COLOR_4 decode configuration;
- a stage-by-stage oracle through vision, canonical classification and unwrap.

A successful oracle pins hashes of the classified coded bytes and final inner
frame without committing the payload itself. A failing capture may instead pin
the first rejected stage and its exact public reason, internal reason and
`diagnosticReason`. The explicit `rejection.stage` is required even though the
stage-by-stage oracle also implies it. Use `null` for `diagnosticReason` only
when the runtime emits no actionable diagnostic code; do not omit the field.
Do not copy a reason from a synthetic run and call it physical evidence.

Metadata template for a successful oracle. The descriptive hash placeholders
below deliberately make it invalid until they are replaced with hashes measured
from the physical capture and its decoded outputs:

```json
{
  "$schema": "../metadata.schema.json",
  "schema": "cvtp-color4-physical-capture",
  "version": 1,
  "provenance": {
    "kind": "physical-camera",
    "device": "controlled device label",
    "browser": "browser and version"
  },
  "rawFrame": {
    "width": 1920,
    "height": 1440,
    "rgbaSha256": "64 lowercase hexadecimal characters",
    "preparation": "unaltered-export",
    "scope": "full-camera-frame"
  },
  "camera": {
    "requested": { "width": 1920, "height": 1440, "frameRate": 30 },
    "actual": { "width": 1920, "height": 1440, "frameRate": 30 },
    "distanceM": 0.5,
    "angleDeg": 0
  },
  "configuration": {
    "carrier": "COLOR_4",
    "expectedProfile": "ROBUST",
    "palette": "KCMY",
    "paletteId": 0,
    "txFps": 5,
    "canonicalScale": 6,
    "maxDetectionDimension": 1280
  },
  "oracle": {
    "vision": { "status": "valid" },
    "classifier": {
      "status": "valid",
      "profile": "ROBUST",
      "paletteId": 0,
      "sequencePhase": 0,
      "codedBytesSha256": "64 lowercase hexadecimal characters"
    },
    "unwrap": {
      "status": "valid",
      "sequence": 0,
      "innerFrameSha256": "64 lowercase hexadecimal characters"
    }
  }
}
```

For a rejected fixture, keep only the stages reached and add this sibling to
the rejected stage. The values below illustrate the shape; record the values
actually produced by the physical replay:

```json
"rejection": {
  "stage": "geometry",
  "publicReason": "invalid-inner-frame",
  "internalReason": "NO_CONTOUR_CANDIDATES",
  "diagnosticReason": null
}
```

Review every image for people, reflections, documents and room details before
committing it. Prefer a controlled scene and crop only when the complete frame,
including its quiet zone, remains present.

With no case directories the test reports an explicit skip. Release or hardware
acceptance must make absence fatal:

```powershell
$env:CVTP_REQUIRE_PHYSICAL_FIXTURES='1'
npm run test:color4
```

On POSIX shells use:

```sh
CVTP_REQUIRE_PHYSICAL_FIXTURES=1 npm run test:color4
```
