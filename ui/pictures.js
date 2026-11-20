// A fixed window includes startup and pauses instead of inflating fast bursts.
export function pictureRate(times, now) {
  return new Set(times.filter(t => t > now - 3 && t <= now)).size / 3;
}
export function fallbackNewPicture(currentTime, previousTime, now, previousRun) {
  return currentTime !== previousTime && now - previousRun >= 1 / 60;
}
export function containedPicture(boxW, boxH, frameW, frameH) {
  const scale = Math.min(boxW / frameW, boxH / frameH);
  const width = frameW * scale, height = frameH * scale;
  // Subpixel layout does not need floating-point tails from the aspect-ratio division.
  const pixel = n => Math.round(n * 1e9) / 1e9;
  return { left: pixel((boxW - width) / 2), top: pixel((boxH - height) / 2), width: pixel(width), height: pixel(height) };
}
