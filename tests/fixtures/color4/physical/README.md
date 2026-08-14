# Physical COLOR_4 replay fixtures

This directory contains privacy-reviewed physical-camera evidence. A fixture
belongs here only when its pixels came from a real camera viewing a real
transmitting display; synthetic rasters belong in the synthetic corpus.

Create one subdirectory per controlled capture:

```text
physical/
  lab-phone-a-001/
    raw-frame.png
    metadata.json
```

`raw-frame.png` is hashed both as compressed PNG bytes and as the 8-bit RGBA
plane decoded by `pngjs`; the test compares them with `rawFrame.pngSha256` and
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
- final PNG dimensions, compressed-PNG hash and decoded-RGBA hash;
- requested and actual negotiated camera width, height and FPS, plus the
  physical setup (actual `getSettings()` values remain authoritative);
- the COLOR_4 decode configuration;
- the prefilter mode and recorded display-brightness condition;
- whether the expected output came from independent transmitter bytes or was
  derived only after a candidate passed RS, CRC32C and wire validation;
- a stage-by-stage oracle through vision, canonical classification and unwrap.

A successful oracle pins hashes of the classified coded bytes and final inner
frame without committing the payload itself. A failing capture may instead pin
the first rejected stage and its exact public reason, internal reason and
`diagnosticReason`. The explicit `rejection.stage` is required even though the
stage-by-stage oracle also implies it. Use `null` for `diagnosticReason` only
when the runtime emits no actionable diagnostic code; do not omit the field.
Do not copy a reason from a synthetic run and call it physical evidence.

`oracle.basis.kind` is deliberately explicit:

- `independent-tx-ground-truth` means the expected inner frame was recorded at
  the transmitter before optical capture;
- `crc-derived-regression` means the expected inner frame was recovered from
  the capture and then pinned only after RS, CRC32C, outer-header identity and
  inner-frame parsing all passed.

A CRC-derived fixture is valuable deterministic regression evidence, but it is
not independent proof that the intended transmitter payload was recovered.
Release acceptance still requires a controlled capture with independent
transmitter bytes and inner-frame SHA-256 verification.

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
    "pngSha256": "64 lowercase hexadecimal characters",
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
    "prefilterMode": "observe",
    "brightness": "maximum",
    "canonicalScale": 6,
    "maxDetectionDimension": 1280
  },
  "oracle": {
    "basis": {
      "kind": "independent-tx-ground-truth",
      "description": "Expected inner bytes recorded at the transmitter before capture."
    },
    "vision": { "status": "valid" },
    "classifier": {
      "status": "valid",
      "profile": "ROBUST",
      "paletteId": 0,
      "sequencePhase": 0,
      "uncertainCells": 0,
      "candidateErasures": {
        "total": 0,
        "byShard": [0, 0, 0, 0, 0, 0]
      },
      "codedBytesSha256": "64 lowercase hexadecimal characters"
    },
    "unwrap": {
      "status": "valid",
      "sessionId": 0,
      "sequence": 0,
      "selectedPolicy": "classifier-budgeted",
      "attempts": 1,
      "selectedErasures": {
        "total": 0,
        "byShard": [0, 0, 0, 0, 0, 0]
      },
      "correctedErrors": 0,
      "correctedBytes": 0,
      "correctedShards": 0,
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

With no case directories the test reports an explicit skip. Normal CI makes
the absence of any physical fixture fatal:

```powershell
$env:CVTP_REQUIRE_PHYSICAL_FIXTURES='1'
npm run test:color4
```

On POSIX shells use:

```sh
CVTP_REQUIRE_PHYSICAL_FIXTURES=1 npm run test:color4
```

Release acceptance is stricter. It requires at least one unaltered
`full-camera-frame` fixture with a valid unwrap whose `oracle.basis.kind` is
`independent-tx-ground-truth`; the current
`capture-000017` CRC-derived regression intentionally does not satisfy this
gate:

```powershell
$env:CVTP_REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE='1'
npm run test:color4
```

On POSIX shells use:

```sh
CVTP_REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE=1 npm run test:color4
```

`CVTP_REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE=1` also makes a completely empty
fixture directory fatal, so the release gate does not need both variables.
