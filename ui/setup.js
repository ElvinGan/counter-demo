export const GREY = [189, 181, 170], SAME = 0.65, EDGE_FLOOR = 6, SAMPLES = 20;

export function smallSize(width, height) {
  if (Math.max(width,height) <= 160) return { width,height };
  const scale = 160/Math.max(width,height);
  return { width: Math.max(16,Math.round(width*scale)), height: Math.max(16,Math.round(height*scale)) };
}

export function backgroundBuilder({ width, height }) {
  const samples = [];
  return {
    get count() { return samples.length; },
    add(rgba, boxes = []) {
      if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== width*height*4) throw new TypeError('Invalid small picture');
      const masked = new Uint8Array(width*height);
      for (const { x,y,w,h } of boxes) {
        const dx = Math.max(2,w*.15), dy = Math.max(2,h*.15);
        const left = Math.max(0,Math.floor(x-dx)), right = Math.min(width,Math.ceil(x+w+dx));
        const top = Math.max(0,Math.floor(y-dy)), bottom = Math.min(height,Math.ceil(y+h+dy));
        if (right <= left || bottom <= top) continue;
        for (let row = top; row < bottom; row++) masked.fill(1,row*width+left,row*width+right);
      }
      samples.push({ data: rgba.slice(),masked });
      if (samples.length > SAMPLES) samples.shift();
    },
    build() {
      const data = new Uint8ClampedArray(width*height*4);
      let painted = 0;
      for (let p = 0; p < width*height; p++) {
        const usable = samples.filter(s => !s.masked[p]);
        if (!usable.length) { data.set(GREY,p*4); painted++; }
        else for (let c = 0; c < 3; c++) {
          const values = usable.map(s => s.data[p*4+c]).sort((a,b) => a-b), mid = Math.floor(values.length/2);
          data[p*4+c] = values.length%2 ? values[mid] : (values[mid-1]+values[mid])/2;
        }
        data[p*4+3] = 255;
      }
      return { width,height,data,painted };
    },
  };
}
function gradients({ width,height,data }) {
  const light = new Float64Array(width*height), map = new Float64Array(width*height);
  for (let p = 0; p < light.length; p++) light[p] = .299*data[p*4]+.587*data[p*4+1]+.114*data[p*4+2];
  for (let y = 1; y < height-1; y++) for (let x = 1; x < width-1; x++) {
    const p = y*width+x;
    map[p] = Math.hypot(light[p+1]-light[p-1],light[p+width]-light[p-width]);
  }
  return map;
}
export function edgeEnergy(picture) {
  const count = (picture.width-2)*(picture.height-2);
  return count > 0 ? gradients(picture).reduce((sum,n) => sum+n,0)/count : 0;
}
export function sameView(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const ga = gradients(a), gb = gradients(b), grey = (data,p) => GREY.every((v,c) => data[p*4+c] === v);
  let n = 0, sa = 0, sb = 0, aa = 0, bb = 0, ab = 0, identical = true;
  for (let y = 1; y < a.height-1; y++) for (let x = 1; x < a.width-1; x++) {
    const p = y*a.width+x;
    if (grey(a.data,p) || grey(b.data,p)) continue;
    const va = ga[p], vb = gb[p];
    n++; sa += va; sb += vb; aa += va*va; bb += vb*vb; ab += va*vb;
    if (Math.abs(va-vb) > 1e-9) identical = false;
  }
  if (!n) return 0;
  if (identical) return 1;
  const variance = Math.sqrt(Math.max(0,aa-sa*sa/n)*Math.max(0,bb-sb*sb/n));
  return variance > 1e-9 ? Math.max(-1,Math.min(1,(ab-sa*sb/n)/variance)) : 0;
}

// Samples carry their dimensions with their bytes; at is epoch milliseconds.
export function viewWatch({ checkSeconds = 60 } = {}) {
  let builder, setup, lastSample, lastBuild, lowAt, score, checking, moved;
  function reset() {
    builder = setup = null; lastSample = -Infinity; lastBuild = lowAt = score = null; checking = true; moved = false;
  }
  reset();
  return {
    reset,
    adopt(picture) {
      reset(); setup = { ...picture,data: picture.data.slice() };
      lastBuild = picture.at ?? null; checking = edgeEnergy(setup) >= EDGE_FLOOR;
    },
    get score() { return score; },
    get count() { return setup ? SAMPLES : builder?.count ?? 0; },
    sample(rgba, boxes, at) {
      if (moved || at-lastSample < 1000 || (setup && !checking)) return null;
      lastSample = at;
      lastBuild ??= setup ? at : null;
      builder ??= backgroundBuilder(rgba);
      builder.add(rgba.data,boxes);
      if (builder.count < SAMPLES || (setup && at-lastBuild < checkSeconds*1000)) return null;
      const picture = builder.build(); builder = null; lastBuild = at;
      if (!setup) {
        setup = picture; checking = edgeEnergy(setup) >= EDGE_FLOOR;
        return { kind: 'picture',picture };
      }
      score = sameView(setup,picture);
      if (score >= SAME) lowAt = null;
      else if (lowAt === null) lowAt = at;
      else { moved = true; return { kind: 'moved',movedAt: lowAt,picture,score }; }
      return null;
    },
  };
}
