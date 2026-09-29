import { test } from "node:test";
import assert from "node:assert/strict";
import { rasterChart } from "./raster-chart.js";

test("finds a coloured line plot inside a screenshot", () => {
  const w = 320, h = 180, rgb = new Uint8Array(w * h * 3).fill(10);
  for (let x = 70; x < 250; x++) {
    const y = Math.round(135 - (x - 70) * .45 + 12 * Math.sin(x / 15));
    for (let dy = 0; dy < 3; dy++) rgb.set([0, 180, 160], ((y + dy) * w + x) * 3);
  }
  const chart = rasterChart(rgb, w, h);
  assert.ok(chart);
  assert.ok(chart.x < 72 && chart.x > 65);
  assert.ok(chart.width > 175);
});

test("ignores neutral screenshots and solid coloured buttons", () => {
  const w = 320, h = 180, rgb = new Uint8Array(w * h * 3).fill(90);
  assert.equal(rasterChart(rgb, w, h), undefined);
  for (let y = 60; y < 95; y++) for (let x = 80; x < 220; x++) rgb.set([0, 180, 160], (y * w + x) * 3);
  assert.equal(rasterChart(rgb, w, h), undefined);
});
