import test from "node:test";
import assert from "node:assert/strict";
import { imageMask } from "../core.js";

test("falls back to the complete silhouette when light-edge segmentation is too fragmented", () => {
  const width = 220, height = 160;
  const data = new Uint8ClampedArray(width * height * 4);
  const paint = (x0, y0, w, h, rgba) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const p = (y * width + x) * 4;
      data.set(rgba, p);
    }
  };

  // One connected original silhouette, with three brightness classes.
  paint(10, 10, 200, 140, [30, 25, 20, 255]);
  paint(15, 15, 30, 30, [120, 100, 70, 255]);
  // More than 150 isolated bright islands make the light-only mask invalid,
  // while the original opaque silhouette remains a simple valid rectangle.
  let dots = 0;
  for (let row = 0; row < 14 && dots < 151; row++) {
    for (let column = 0; column < 11 && dots < 151; column++) {
      paint(70 + column * 12, 30 + row * 8, 5, 5, [255, 255, 255, 255]);
      dots++;
    }
  }

  const result = imageMask({ width, height, data }, { highlightFaces: true });
  assert.equal(result.stats.highlightRequested, true);
  assert.equal(result.stats.highlightApplied, false);
  assert.equal(result.stats.highlightReason, "geometry_fallback");
  assert.equal(result.stats.shapes, 1);
  assert.ok(result.points.length >= 3 && result.points.length <= 240);
});
