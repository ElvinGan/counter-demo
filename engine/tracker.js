function measurement(box) {
  const height = box.y2 - box.y1;
  return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2, (box.x2 - box.x1) / height, height];
}

class Motion {
  constructor(box, frameRate) {
    this.frameRate = frameRate;
    this.mean = new Float64Array(8);
    this.mean.set(measurement(box));
    // With diagonal observation/process noise, the 8D covariance stays in four independent 2x2 blocks.
    this.covariance = Array.from({ length: 4 }, (_, i) => {
      const pos = i === 2 ? 0.01 : this.mean[3] / 10;
      const speed = i === 2 ? 0.01 * frameRate : this.mean[3] * 10 / 160 * frameRate;
      return [pos * pos, 0, speed * speed];
    });
  }

  predict(dt) {
    const height = Math.max(1, this.mean[3]);
    for (let i = 0; i < 4; i++) {
      const [p, cross, v] = this.covariance[i];
      const positionNoise = i === 2 ? 0.01 : height / 20;
      const velocityNoise = (i === 2 ? 0.00001 : height / 160) * this.frameRate;
      const q = velocityNoise ** 2 * this.frameRate;
      this.mean[i] += dt * this.mean[i + 4];
      this.covariance[i] = [
        p + 2 * dt * cross + dt * dt * v + positionNoise ** 2 * dt * this.frameRate + q * dt ** 3 / 3,
        cross + dt * v + q * dt * dt / 2,
        v + q * dt,
      ];
    }
    this.mean[2] = Math.max(0.001, this.mean[2]);
    this.mean[3] = Math.max(0.001, this.mean[3]);
  }

  correct(box) {
    const observed = measurement(box), height = Math.max(1, this.mean[3]);
    for (let i = 0; i < 4; i++) {
      const [p, cross, v] = this.covariance[i];
      const r = (i === 2 ? 0.1 : height / 20) ** 2;
      const gain = p / (p + r), velocityGain = cross / (p + r);
      const error = observed[i] - this.mean[i];
      this.mean[i] += gain * error; this.mean[i + 4] += velocityGain * error;
      this.covariance[i] = [Math.max(0, p * (1 - gain)), cross * (1 - gain), Math.max(0, v - velocityGain * cross)];
    }
  }

  box() {
    const [x, y, aspect, height] = this.mean, width = aspect * height;
    return { x1: x - width / 2, y1: y - height / 2, x2: x + width / 2, y2: y + height / 2 };
  }
}

function iou(a, b) {
  const intersection = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
    * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

function hungarian(cost) {
  const rows = cost.length, cols = cost[0].length;
  const u = new Float64Array(rows + 1), v = new Float64Array(cols + 1);
  const p = new Int32Array(cols + 1), way = new Int32Array(cols + 1);
  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    const min = new Float64Array(cols + 1).fill(Infinity), used = new Uint8Array(cols + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < min[j]) { min[j] = current; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const assignments = new Int32Array(rows).fill(-1);
  for (let j = 1; j <= cols; j++) if (p[j]) assignments[p[j] - 1] = j - 1;
  return assignments;
}

function associate(tracks, detections, threshold) {
  if (!tracks.length || !detections.length) return { pairs: [], tracks, detections };
  // Dummy columns allow unmatched tracks; their cost prioritises cardinality, then total IoU.
  const unmatchedCost = tracks.length + 1;
  const costs = tracks.map(track => {
    const predicted = track.motion.box();
    return [...detections.map(d => {
      const distance = 1 - iou(predicted, d);
      return distance <= threshold ? distance : unmatchedCost * (tracks.length + 2);
    }), ...tracks.map(() => unmatchedCost)];
  });
  const assignments = hungarian(costs), pairs = [], usedTracks = new Set(), usedDetections = new Set();
  assignments.forEach((j, i) => {
    if (j >= 0 && j < detections.length && costs[i][j] <= threshold) {
      pairs.push([tracks[i], detections[j]]); usedTracks.add(i); usedDetections.add(j);
    }
  });
  return { pairs, tracks: tracks.filter((_, i) => !usedTracks.has(i)),
    detections: detections.filter((_, i) => !usedDetections.has(i)) };
}

export class Tracker {
  constructor({ frameRate = 8, trackThresh = 0.25, matchThresh = 0.8, lostSeconds = 1.0, minHits = 1 } = {}) {
    if (!Number.isFinite(frameRate) || frameRate <= 0 || !Number.isFinite(lostSeconds) || lostSeconds < 0
      || !Number.isInteger(minHits) || minHits < 1
      || ![trackThresh, matchThresh].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
      throw new RangeError('Invalid tracker options');
    }
    Object.assign(this, { frameRate, trackThresh, matchThresh, lostSeconds, minHits });
    this.tracks = []; this.nextId = 1; this.lastTime = null;
  }

  update(dets, t) {
    if (!Number.isFinite(t) || (this.lastTime !== null && t < this.lastTime)) {
      throw new RangeError('Tracker time must be finite and nondecreasing');
    }
    const dt = this.lastTime === null ? 0 : t - this.lastTime;
    this.lastTime = t;
    this.tracks = this.tracks.filter(track => t - track.lastSeen <= this.lostSeconds);
    for (const track of this.tracks) { track.motion.predict(dt); track.matched = false; }
    const valid = dets.filter(d => [d.x1, d.y1, d.x2, d.y2, d.score].every(Number.isFinite)
      && d.x2 > d.x1 && d.y2 > d.y1);
    const high = valid.filter(d => d.score >= this.trackThresh);
    const weak = valid.filter(d => d.score >= 0.1 && d.score < this.trackThresh);
    const first = associate(this.tracks, high, this.matchThresh);
    const second = associate(first.tracks, weak, this.matchThresh);
    for (const [track, detection] of [...first.pairs, ...second.pairs]) {
      track.motion.correct(detection); track.score = detection.score;
      track.lastSeen = t; track.hits++; track.matched = true;
    }
    for (const detection of first.detections) {
      this.tracks.push({ id: this.nextId++, motion: new Motion(detection, this.frameRate),
        score: detection.score, lastSeen: t, hits: 1, matched: true });
    }
    return this.tracks.filter(track => track.matched && track.hits >= this.minHits)
      .map(track => ({ id: track.id, ...track.motion.box(), score: track.score }));
  }
}
