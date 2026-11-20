// Keep clip choices together so deployments can supply footage without changing the player.
// Sources and licences: SOURCES.md beside this file. Geometry was placed by eye on each clip.
export const clips = {
  walkway: { file: './videos/walkway.mp4?v=1fdba0f9', credit: '"People Walking Free Stock Footage, Royalty-Free No Copyright Content", Montreal Walking Tours, on YouTube.',
    geometry: { line: { ax: .26, ay: .02, bx: .26, by: 1 }, zone: { x1: .81, y1: .11, x2: 1, y2: 1 } }, inSide: 1, stopSeconds: 5 },
  doorway: { file: './videos/doorway.mp4?v=ca6b31f1', credit: '"The CCTV People Demo 1", CCTV People, on YouTube. The shop door is at the top of the picture. Played 1.5 times faster.',
    geometry: { line: { ax: .05, ay: .50, bx: .75, by: .50 } }, inSide: -1, stopSeconds: 5 },
  counter: { file: './videos/counter.mp4?v=4a9c697e', credit: '"HD-SDI 1080P Hi Definition Megapixel Security Camera @ Super Market Checkout Sample #1", www.CCTVFACTORY.com, on YouTube. The box covers where shoppers stand at the middle till.',
    geometry: { zone: { x1: .50, y1: .12, x2: .66, y2: .80 } }, inSide: 1, stopSeconds: 5 },
  shelf:   { file: './videos/shelf.mp4?v=5d87ecca',   credit: '"HD CCTV Camera video 3MP 4MP iProx CCTV HDCCTVCameras.net retail store", HDCCTV Cameras, on YouTube.',
    geometry: { zone: { x1: .62, y1: .2, x2: .97, y2: .66 } }, inSide: 1, stopSeconds: 5 },
  tables:  { file: './videos/tables.mp4?v=1234098d',  credit: '"Customers in a minimalist style restaurant", Mixkit. A time-lapse, slowed down.',
    geometry: { tables: [
      { id: 1, section: 'Room', x1: .48, y1: .26, x2: .76, y2: .44 },
      { id: 2, section: 'Room', x1: .47, y1: .44, x2: .78, y2: .66 },
      { id: 3, section: 'Room', x1: .45, y1: .66, x2: .80, y2: 1 },
    ] }, inSide: 1, stopSeconds: 5 },
};
