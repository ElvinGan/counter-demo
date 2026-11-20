import { initialGeometry } from './counts.js';

export function clipGeometry(spot, geometry) {
  return geometry == null ? initialGeometry(spot) : structuredClone(geometry);
}

export function repeatTimeline(lastTime, realTime, offset = 0) {
  const absent = Math.max(realTime + offset, lastTime + .000001);
  // Two empty observations expire the 1 s tracks and 1.5 s graces, but preserve a table's 20 s vacancy grace.
  const expired = absent + 2;
  return { times: [absent, expired], offset: expired - realTime };
}
