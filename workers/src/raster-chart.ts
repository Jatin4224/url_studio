/** Find a substantial, non-rectangular coloured plot inside a dashboard screenshot.
 * Neutral text/background pixels are excluded; nearby line pixels are connected before scoring.
 */
export function rasterChart(rgb: Uint8Array, width: number, height: number) {
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = (y * width + x) * 3;
    const high = Math.max(rgb[i], rgb[i + 1], rgb[i + 2]);
    const low = Math.min(rgb[i], rgb[i + 1], rgb[i + 2]);
    if (high < 55 || high - low < 40 || (high - low) / high < .4) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mask[(y + dy) * width + x + dx] = 1;
  }
  const candidates = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    const queue = [start]; mask[start] = 0;
    let left = width, top = height, right = 0, bottom = 0;
    for (let n = 0; n < queue.length; n++) {
      const p = queue[n], x = p % width, y = Math.floor(p / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const next of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (next >= 0 && next < mask.length && mask[next]) { mask[next] = 0; queue.push(next); }
      }
    }
    const w = right - left + 1, h = bottom - top + 1;
    const density = queue.length / (w * h);
    if (w >= width * .12 && h >= height * .08 && w / h > .7 && w / h < 8 && density < .85 && density > .015)
      candidates.push({ x: left, y: top, width: w, height: h, score: w * h });
  }
  return candidates.sort((a, b) => b.score - a.score)[0];
}
