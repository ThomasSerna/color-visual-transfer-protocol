# Canonical COLOR_4 replay fixtures

These fixtures start at the canonical-raster boundary. They exercise bootstrap,
timing, phase, calibration, colour classification and Reed-Solomon handling,
but they do not replay camera acquisition, contour detection, fiducial search or
homography estimation. Do not use them as evidence that the OpenCV path or a
physical transfer works end to end.

Only the privacy-reviewed warped artifact is stored here. The corresponding raw
camera frame is deliberately excluded because it contains browser and room
context. Physical full-frame captures, when safe to retain, belong under
`../physical/` and have a different evidence contract.

## `capture-000017`

`capture-000017-warped.png` is the lossless 1032 x 1032 RGBA canonical frame
(172 modules at scale 6) recovered from a Debug Vision bundle.
`bootstrap-luma.json` is the corresponding textual 3 x 24 bootstrap matrix,
derived with the classifier's center-inset median RGB sampling and BT.709
luminance coefficients. It pins the photometric oracle without duplicating or
re-encoding the PNG.

- PNG SHA-256: `3af7b4dd41ef15447fc54f7ef99e2d150a3f8a754b5c6a8a900003ae8e864bcc`
- decoded RGBA SHA-256: `86ebacb71a5bb9268848c3c478cdc51452ad4671d30bd38dc0d20e03a1402554`
- expected classifier result: PHY 1, ROBUST, KCMY, phase 3
- expected timing result: 0 errors across 314 modules
- expected classification result: 219 uncertain cells and 195 erased bytes
- coded-byte SHA-256: `fd777331c87b26bbdc019c2b78eccd4713e62bb942df2bcca62e9128b75536df`
- expected unwrap result: `fec-uncorrectable`, localized as
  `COLOR_CLASSIFICATION_TOO_UNCERTAIN`

The expected FEC rejection is intentional. This fixture pins the phase-1
photometric fix through classification/RS; it is not a successful-transfer
fixture.
