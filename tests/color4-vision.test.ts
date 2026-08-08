import assert from "node:assert/strict";
import test from "node:test";
import { fiducialModule } from "../shared/color4/physical.ts";
import { identifyFiducialModules, projectiveQuadCenter } from "../receive/color4-vision.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";

function marker(id: "TL" | "TR" | "BR" | "BL"): Uint8Array {
  const modules = new Uint8Array(81);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) modules[y * 9 + x] = fiducialModule(id, x, y);
  }
  return modules;
}

test("fiducial identification corrects at most four module errors", () => {
  const modules = marker("TL");
  for (const index of [20, 21, 22, 23]) modules[index] = modules[index]! ^ 1;
  assert.deepEqual(identifyFiducialModules(modules), { id: "TL", errors: 4 });
  modules[24] = modules[24]! ^ 1;
  assert.equal(identifyFiducialModules(modules), null);
});

test("fiducial midpoint between two IDs is rejected as ambiguous", () => {
  const between = marker("TL");
  const other = marker("TR");
  const differences = [...between.keys()].filter((index) => between[index] !== other[index]);
  assert.ok(differences.length >= 10);
  for (const index of differences.slice(0, Math.floor(differences.length / 2))) {
    between[index] = other[index]!;
  }
  assert.equal(identifyFiducialModules(between), null);
});

test("fiducial center uses the perspective-invariant diagonal intersection", () => {
  const quad = [
    { x: 285, y: 110 },
    { x: 1015, y: 170 },
    { x: 975, y: 845 },
    { x: 235, y: 790 },
  ];
  const center = projectiveQuadCenter(quad);
  assert.ok(Math.abs(center.x - 629.20737189092) < 1e-9);
  assert.ok(Math.abs(center.y - 476.65567875337126) < 1e-9);
  const arithmeticX = quad.reduce((sum, point) => sum + point.x / 4, 0);
  const arithmeticY = quad.reduce((sum, point) => sum + point.y / 4, 0);
  assert.ok(Math.hypot(center.x - arithmeticX, center.y - arithmeticY) > 2);
});

test("the physical Gray phase is bound to sequence modulo four", () => {
  assert.equal(color4SequencePhaseMatches(0x1020_3042, 2), true);
  assert.equal(color4SequencePhaseMatches(0x1020_3042, 0), false);
  assert.equal(color4SequencePhaseMatches(-1, 3), false);
  assert.equal(color4SequencePhaseMatches(0x1_0000_0000, 0), false);
});
