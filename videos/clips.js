// Keep clip choices together so deployments can supply footage without changing the player.
// Sources and licences: SOURCES.md beside this file. Geometry was placed by eye on each clip.
export const clips = {
  walkway: { file: './videos/walkway.mp4', credit: '"The CCTV People Demo 2", CCTV People, on YouTube.',
    geometry: { line: { ax: .05, ay: .62, bx: .80, by: .62 }, zone: { x1: .68, y1: .4, x2: .9, y2: .98 } }, inSide: 1, stopSeconds: 5 },
  doorway: { file: './videos/doorway.mp4', credit: '"The CCTV People Demo 2", CCTV People, on YouTube. The shop door is at the right edge.',
    geometry: { line: { ax: .88, ay: .40, bx: .88, by: 1 } }, inSide: 1, stopSeconds: 5 },
  counter: { file: './videos/counter.mp4', credit: '"IGA Supermarket: 2mp IP camera (check-out overview)", Liveforce Security Systems, on YouTube.',
    geometry: { zone: { x1: .56, y1: .1, x2: .81, y2: .75 } }, inSide: 1, stopSeconds: 5 },
  shelf:   { file: './videos/shelf.mp4',   credit: '"HD CCTV Camera video 3MP 4MP iProx CCTV HDCCTVCameras.net retail store", HDCCTV Cameras, on YouTube.',
    geometry: { zone: { x1: .62, y1: .2, x2: .97, y2: .66 } }, inSide: 1, stopSeconds: 5 },
  tables:  { file: './videos/tables.mp4',  credit: '"Customers in a minimalist style restaurant", Mixkit. A time-lapse, slowed down.',
    geometry: { tables: [
      { id: 1, section: 'Room', x1: .48, y1: .26, x2: .76, y2: .44 },
      { id: 2, section: 'Room', x1: .47, y1: .44, x2: .78, y2: .66 },
      { id: 3, section: 'Room', x1: .45, y1: .66, x2: .80, y2: 1 },
    ] }, inSide: 1, stopSeconds: 5 },
};
