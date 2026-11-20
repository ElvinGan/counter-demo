export function makeGrid(inputW, inputH) {
  if (!Number.isInteger(inputW) || !Number.isInteger(inputH) || inputW < 1 || inputH < 1) {
    throw new RangeError('Input dimensions must be positive integers');
  }
  const count = [8, 16, 32].reduce((n, stride) => n + Math.floor(inputW / stride) * Math.floor(inputH / stride), 0);
  const grid = new Float32Array(count * 2), strides = new Float32Array(count);
  let i = 0;
  for (const stride of [8, 16, 32]) {
    for (let y = 0; y < Math.floor(inputH / stride); y++) {
      for (let x = 0; x < Math.floor(inputW / stride); x++, i++) {
        grid[2 * i] = x; grid[2 * i + 1] = y; strides[i] = stride;
      }
    }
  }
  return { grid, strides };
}

export function letterbox(frameW, frameH, inputW, inputH) {
  if (![frameW, frameH, inputW, inputH].every(v => Number.isFinite(v) && v > 0)) {
    throw new RangeError('Frame and input dimensions must be positive');
  }
  const ratio = Math.min(inputH / frameH, inputW / frameW);
  // Python's int truncation determines the actual top-left image area; the caller pads with 114.
  return { ratio, drawW: Math.floor(frameW * ratio), drawH: Math.floor(frameH * ratio) };
}

export function rgbaToTensor(rgba, inputW, inputH) {
  if (!Number.isInteger(inputW) || !Number.isInteger(inputH) || inputW < 1 || inputH < 1
    || rgba.length !== inputW * inputH * 4) throw new RangeError('RGBA size does not match input dimensions');
  const size = inputW * inputH, tensor = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    tensor[i] = rgba[4 * i + 2]; tensor[size + i] = rgba[4 * i + 1]; tensor[2 * size + i] = rgba[4 * i];
  }
  return tensor;
}

function iou(a, b) {
  const intersection = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
    * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

export function decodeYolox(raw, { inputW, inputH, ratio, conf = 0.45, nmsIou = 0.45 }) {
  const { grid, strides } = makeGrid(inputW, inputH);
  if (!(raw instanceof Float32Array) || raw.length !== strides.length * 85) {
    throw new RangeError('Expected Float32Array output with shape [1, N, 85]');
  }
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(conf) || conf < 0 || conf > 1
    || !Number.isFinite(nmsIou) || nmsIou < 0 || nmsIou > 1) throw new RangeError('Invalid decode options');
  const candidates = [];
  for (let i = 0; i < strides.length; i++) {
    const j = i * 85, stride = strides[i];
    const score = Math.fround(raw[j + 4] * raw[j + 5]);
    // NMSBoxes uses a strict score threshold after the reference's inclusive prefilter.
    if (!(score > conf)) continue;
    // Float32 rounding mirrors the numpy arrays rather than accumulating double precision steps.
    const x = Math.fround(Math.fround(raw[j] + grid[i * 2]) * stride);
    const y = Math.fround(Math.fround(raw[j + 1] + grid[i * 2 + 1]) * stride);
    const w = Math.fround(Math.fround(Math.exp(raw[j + 2])) * stride);
    const h = Math.fround(Math.fround(Math.exp(raw[j + 3])) * stride);
    const box = {
      x1: Math.fround(Math.fround(x - w / 2) / ratio), y1: Math.fround(Math.fround(y - h / 2) / ratio),
      x2: Math.fround(Math.fround(x + w / 2) / ratio), y2: Math.fround(Math.fround(y + h / 2) / ratio), score,
    };
    if (Object.values(box).every(Number.isFinite) && w > 0 && h > 0) candidates.push(box);
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of candidates) if (!kept.some(other => iou(box, other) > nmsIou)) kept.push(box);
  return kept;
}
