import { WalkwayCounter, DoorwayCounter, ZoneStopCounter, QueueCounter, TablesCounter } from '../engine/rules.js';
export function initialGeometry(spot) {
  if (spot === 'tables') return { tables: Array.from({ length: 4 }, (_, i) => ({
    id: i + 1, section: 'Room', x1: .08 + (i % 2) * .48, y1: .08 + Math.floor(i / 2) * .48,
    x2: .43 + (i % 2) * .48, y2: .43 + Math.floor(i / 2) * .48,
  })) };
  if (spot === 'doorway') return { line: { ax: .25, ay: .72, bx: .75, by: .72 } };
  if (spot === 'walkway') return { line: { ax: .33, ay: .08, bx: .33, by: .92 }, zone: { x1: .65, y1: .11, x2: .96, y2: .94 } };
  return { zone: { x1: .22, y1: .2, x2: .8, y2: .85 } };
}
export function pixelGeometry(geometry, width, height) {
  const scale = box => Object.fromEntries(Object.entries(box).map(([key, value]) => [key,
    /^(?:x[12]|[ab]x)$/.test(key) ? value * width : /^(?:y[12]|[ab]y)$/.test(key) ? value * height : value]));
  return { line: geometry.line && scale(geometry.line), zone: geometry.zone && scale(geometry.zone), tables: geometry.tables?.map(scale) };
}
export function makeCounters(spot, geometry, stopSeconds, inSide) {
  let main, stop;
  if (spot === 'walkway') { main = new WalkwayCounter({ line: geometry.line }); stop = new ZoneStopCounter({ zone: geometry.zone, stopSeconds }); }
  if (spot === 'doorway') main = new DoorwayCounter({ line: geometry.line, inSide });
  if (spot === 'counter') main = new QueueCounter({ zone: geometry.zone });
  if (spot === 'shelf') main = new ZoneStopCounter({ zone: geometry.zone, stopSeconds });
  if (spot === 'tables') main = new TablesCounter({ tables: geometry.tables });
  return { update(people, t) { main.update(people, t); stop?.update(people, t); },
    snapshot() { return stop ? { ...main.snapshot(), stopped: stop.snapshot() } : main.snapshot(); } };
}

export function nextTableBox(tables) {
  // Try normal boxes first, then smaller boxes to use gaps between existing tables.
  for (const size of [.3, .2, .1]) {
    const xs = [...new Set([0, ...tables.map(t => t.x2)])].sort((a,b) => a-b);
    const ys = [...new Set([0, ...tables.map(t => t.y2)])].sort((a,b) => a-b);
    for (const y1 of ys) for (const x1 of xs) {
      const box = { x1, y1, x2: x1+size, y2: y1+size };
      if (box.x2<=1 && box.y2<=1 && tables.every(t => box.x2<=t.x1 || box.x1>=t.x2 || box.y2<=t.y1 || box.y1>=t.y2)) return box;
    }
  }
  const last = tables.at(-1) ?? { x1: .3, y1: .3 };
  const x1 = Math.min(.7,last.x1+.03), y1 = Math.min(.7,last.y1+.03);
  return { x1,y1,x2:x1+.3,y2:y1+.3 };
}
