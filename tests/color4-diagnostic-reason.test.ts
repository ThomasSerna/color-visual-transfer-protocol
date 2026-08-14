import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalDiagnosticReason,
  fecDiagnosticReason,
} from "../receive/color4-diagnostic-reason";

const clean = {
  fiducialErrorMax: 0,
  quietZoneErrors: 0,
  quietZoneLumaErrors: 0,
  quietZoneRgbErrors: 0,
};

test("canonical rejection causes remain separate without changing public reasons", () => {
  assert.equal(canonicalDiagnosticReason("invalid_dimensions", undefined), "CANONICAL_DIMENSIONS");
  assert.equal(canonicalDiagnosticReason("invalid_geometry", { ...clean, fiducialErrorMax: 5 }, "canonicalGeometry"), "FIDUCIAL_CANONICAL");
  assert.equal(canonicalDiagnosticReason("invalid_geometry", {
    ...clean,
    quietZoneErrors: 8,
    quietZoneLumaErrors: 8,
    quietZoneRgbErrors: 8,
  }, "canonicalGeometry"), "QUIET_ZONE_LUMA");
  assert.equal(canonicalDiagnosticReason("invalid_geometry", {
    ...clean,
    quietZoneErrors: 8,
    quietZoneRgbErrors: 8,
  }, "canonicalGeometry"), "QUIET_ZONE_RGB");
  assert.equal(canonicalDiagnosticReason("invalid_geometry", clean, "bootstrapPhase"), "TIMING");
  assert.equal(canonicalDiagnosticReason("invalid_bootstrap", clean), "BOOTSTRAP");
  assert.equal(canonicalDiagnosticReason("phase_mismatch", clean), "PHASE");
  assert.equal(canonicalDiagnosticReason("calibration_failed", clean), "CALIBRATION");
});

test("classification uncertainty is reserved for RS too-many-erasures", () => {
  assert.equal(fecDiagnosticReason("fec-uncorrectable", ["too-many-erasures"]), "COLOR_CLASSIFICATION_TOO_UNCERTAIN");
  assert.equal(fecDiagnosticReason("fec-uncorrectable", ["locator"], true), "COLOR_CLASSIFICATION_TOO_UNCERTAIN");
  assert.equal(fecDiagnosticReason("fec-uncorrectable", ["locator"]), "RS_FAILED");
  assert.equal(fecDiagnosticReason("crc-mismatch"), "CRC_FAILED");
  assert.equal(fecDiagnosticReason("invalid-inner-frame"), undefined);
});
