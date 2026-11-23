import { historyReport, durationWords } from './keep.js';

// Shared by live preview, camera cards and history; pixels never leave a canvas.
export function drawSetup(canvas, picture, geometry = {}) {
  canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label',picture ? 'Setup picture, people painted out, with counting areas' : 'No setup picture yet');
  if (!picture) { canvas.width = 84; canvas.height = 60; return; }
  canvas.width = picture.width; canvas.height = picture.height;
  canvas.style.maxWidth = `${picture.width*2}px`; canvas.style.maxHeight = `${picture.height*2}px`;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(picture.width,picture.height);
  pixels.data.set(picture.data); ctx.putImageData(pixels,0,0);
  ctx.strokeStyle = '#ff630f'; ctx.lineWidth = 2;
  const { width:w,height:h } = picture;
  if (geometry.line) {
    const { ax,ay,bx,by } = geometry.line;
    ctx.beginPath(); ctx.moveTo(ax*w,ay*h); ctx.lineTo(bx*w,by*h); ctx.stroke();
  }
  for (const box of [geometry.zone,...(geometry.tables ?? [])].filter(Boolean)) {
    ctx.strokeRect(box.x1*w,box.y1*h,(box.x2-box.x1)*w,(box.y2-box.y1)*h);
  }
}
export function latestPicture(pictures, cameraId) {
  return pictures.filter(p => p.cameraId === cameraId).sort((a,b) => b.at-a.at)[0];
}

export function historyScreen({ keeper, back, onProblem, start = () => {}, root = document, now = () => Date.now(),
  later = setTimeout, cancel = clearTimeout }) {
  const $ = id => root.getElementById(id);
  let sessions = [], events = [], cameras = [], pictures = [], camera = null, selection = '', range = 'today', armedUntil = 0, timer = null, revision = 0;
  const clearText = 'Clear the history on this device';
  function node(tag,text) {
    const element = root.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function disarm() {
    armedUntil = 0; cancel(timer); timer = null; $('clear-history').textContent = clearText;
  }
  function draw() {
    const empty = sessions.length === 0 && !cameras.some(c => c.removedAt === null);
    $('history-empty').hidden = !empty;
    for (const id of ['history-what','history-bars','history-sessions','history-summary','history-ranges','history-what-label','clear-history']) $(id).hidden = empty;
    for (const value of ['today','week','month']) $(`range-${value}`).setAttribute('aria-pressed',String(range === value));
    const report = historyReport(sessions,events,{ selection,range,now: now(),openId: keeper.sessionId, cameras });
    selection = report.selection;
    $('history-what').replaceChildren(...['A group','One camera'].flatMap(group => {
      const options = report.options.filter(option => option.group === group);
      if (!options.length) return [];
      const element = node('optgroup'); element.label = group;
      element.append(...options.map(option => { const el = node('option',option.label); el.value = option.value; return el; }));
      return [element];
    }));
    camera = report.camera;
    $('history-camera').hidden = !camera;
    $('history-count').hidden = !camera || camera.removed;
    $('history-camera-kind').textContent = camera ? `${camera.kind}, ${camera.source}` : '';
    $('history-camera-status').textContent = camera?.status ?? '';
    const picture = camera && latestPicture(pictures,camera.id);
    $('history-camera-picture').hidden = !picture;
    if (picture) drawSetup($('history-camera-picture'),picture,sessions.find(s => s.id === picture.sessionId)?.geometry);
    const none = camera && !sessions.some(s => s.cameraId === camera.id);
    $('history-none').hidden = !none;
    $('history-bars').hidden = empty || Boolean(none);
    $('history-bars').dataset.range = range;
    $('history-compare').hidden = empty || Boolean(none);
    $('compare-title').textContent = report.compare.title;
    $('compare-values').hidden = report.compare.none !== null;
    $('compare-none').hidden = report.compare.none === null;
    $('compare-none').textContent = report.compare.none ?? '';
    for (const side of ['now','before']) {
      $(`compare-${side}`).textContent = report.compare[side]?.text ?? '';
      $(`compare-${side}-label`).textContent = report.compare[side]?.label ?? '';
    }
    $('history-what').value = selection;
    $('history-main').textContent = report.main; $('history-main-label').textContent = report.label;
    $('history-covered').textContent = report.covered;
    const maximum = Math.max(1,...report.rows.map(row => row.value));
    $('history-bars').replaceChildren(...report.rows.map(row => {
      const li = node('li'); li.dataset.from = row.from; li.dataset.value = row.value; li.dataset.countedMs = row.countedMs;
      const label = node('span',row.label), bar = node('span'), number = node('b',row.value), detail = node('small');
      bar.className = 'history-bar'; bar.setAttribute('aria-hidden','true');
      if (!row.countedMs) {
        li.className = 'gap'; detail.textContent = 'not counting'; li.append(label,bar,detail);
      } else {
        bar.style.width = `${100*row.value/maximum}%`;
        li.append(label,bar,number);
        if (range === 'month' || row.countedMs < row.fullMs-60000) { detail.textContent = `counted ${durationWords(row.countedMs)}`; li.append(detail); }
      }
      return li;
    }));
    $('history-sessions').replaceChildren(...report.sessions.map(session => {
      const li = node('li'); li.dataset.session = session.id;
      const picture = pictures.find(p => p.sessionId === session.id);
      if (picture) {
        const canvas = node('canvas'); canvas.className = 'session-picture';
        drawSetup(canvas,picture,sessions.find(s => s.id === session.id)?.geometry); li.append(canvas);
      }
      li.append(node('b',session.time),node('span',session.end),node('span',session.cameraName),node('span',session.totals));
      return li;
    }));
  }
  async function refresh() {
    const current = ++revision;
    try {
      const [data, saved, stills] = await Promise.all([keeper.read(),keeper.listCameras(),keeper.listPictures()]);
      if (current !== revision) return;
      sessions = data.sessions; events = data.events; cameras = saved; pictures = stills; draw();
    } catch { if (current === revision) onProblem('History could not be read on this device. Try opening it again.'); }
  }
  $('history-count').addEventListener('click',() => { if (camera && !camera.removed) start(cameras.find(c => c.id === camera.id)); });
  $('history-back').addEventListener('click',() => { revision++; disarm(); back(); });
  $('history-what').addEventListener('change',() => { selection = $('history-what').value; draw(); });
  for (const value of ['today','week','month']) $(`range-${value}`).addEventListener('click',() => { range = value; draw(); });
  $('clear-history').addEventListener('click',async () => {
    if (armedUntil > now()) {
      disarm(); $('clear-history').disabled = true;
      try { await keeper.clear(); await refresh(); }
      finally { $('clear-history').disabled = false; }
    } else {
      disarm(); armedUntil = now()+5000;
      $('clear-history').textContent = 'Tap again to clear every count kept on this device';
      timer = later(disarm,5000);
    }
  });
  return { close() { revision++; disarm(); }, open({ select = '' } = {}) { selection = select; range = 'today'; disarm(); return refresh(); } };
}
