import { letterbox, rgbaToTensor, decodeYolox } from './engine/detect.js';
import { Tracker } from './engine/tracker.js';
import { createRunner, modelSizes } from './ui/model.js';
import { initialGeometry, pixelGeometry, makeCounters, nextTableBox } from './ui/counts.js';
import { geometryEditor, drawOverlay } from './ui/geometry.js';
import { pictureRate, fallbackNewPicture, pictureTime, containedPicture } from './ui/pictures.js';
const $ = id => document.getElementById(id);
const video = $('video'), overlay = $('overlay');
const titles = { walkway: 'Walkway', doorway: 'Doorway', counter: 'Counter', shelf: 'Shelf', tables: 'Tables' };
const params = new URLSearchParams(location.search);
let model = Object.hasOwn(modelSizes, params.get('model')) ? params.get('model') : 'tiny';
let stopSeconds = [5,10,30,60].includes(Number(params.get('stop'))) ? Number(params.get('stop')) : 10;
let screen = 'start', spot = null, cameraOn = false, backend = 'wasm';
let picturesCounted = 0, picturesPerSecond = 0, counts = {};
let generation = 0, revision = 0, stream = null, helperStop = null, source = 'device', cameraName = null;
let helper = null, devices = [], selectedDevice = null, mirrored = false, editing = false;
let geometry = initialGeometry('walkway'), inSide = 1, counter = null, tracker = new Tracker(), people = [];
let runner = null, runnerModel = null, modelQueue = Promise.resolve(), frameTask = Promise.resolve();
let pictureController = null;
let timer = null, videoCallback = null, rateTimer = null, noticeTimer = null;
let lastVideoTime = -1, lastRun = -Infinity, lastTime = -Infinity, lastMediaTime = null;
let pictureTimes = [], loadingModel = false, width = 0, height = 0, tableId = 4;
let freeSince = new Map(), tableRows = new Map(), lastRender = 0;
const input = document.createElement('canvas'), inputContext = input.getContext('2d', { willReadFrequently: true });
function freezeSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSnapshot));
  return value && typeof value === 'object' ? Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v]) => [k,freezeSnapshot(v)]))) : value;
}
Object.defineProperty(window, '__footfall', { value: Object.freeze({
  get screen() { return screen; }, get spot() { return spot; }, get backend() { return backend; },
  get model() { return model; }, get picturesCounted() { return picturesCounted; },
  get picturesPerSecond() { return pictureRate(pictureTimes,performance.now()/1000); }, get counts() { return freezeSnapshot(counts); },
  get cameraOn() { return cameraOn; },
}), writable: false, configurable: false });
function say(message, duration = 0) {
  clearTimeout(noticeTimer); $('status').textContent = message;
  if (duration) noticeTimer = setTimeout(() => { $('status').textContent = ''; },duration);
}
function announceReset() {
  if (cameraOn) say('The counting area changed, so the counts have started again.',4000);
}
function cancelPicture() {
  clearTimeout(timer); timer = null;
  if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback);
  videoCallback = null;
}
function show(next) {
  screen = next;
  $('start-screen').hidden = next !== 'start'; $('counting-screen').hidden = next !== 'counting'; $('source-screen').hidden = next !== 'source';
  const heading = next === 'start' ? $('start-title') : next === 'counting' ? $('spot-title') : $('source-title');
  heading.tabIndex = -1; heading.focus();
}
function stopCamera(message = '') {
  generation++; pictureController?.abort(); pictureController = null; cancelPicture();
  clearInterval(rateTimer); editor.cancelPending();
  cameraOn = false; loadingModel = false; picturesPerSecond = 0; pictureTimes = [];
  lastVideoTime = -1; lastRun = lastTime = -Infinity; lastMediaTime = null;
  const stop = helperStop; helperStop = null;
  if (stop) { try { Promise.resolve(stop()).catch(() => say('The Wi-Fi camera could not disconnect cleanly; close this tab to finish stopping it.')); } catch { say('The Wi-Fi camera could not disconnect cleanly; close this tab to finish stopping it.'); } }
  for (const track of stream?.getTracks() ?? []) track.stop();
  for (const track of video.srcObject?.getTracks?.() ?? []) track.stop();
  stream = null; video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  $('stop-camera').hidden = true; $('restart-camera').hidden = false; $('switch-camera').hidden = true;
  $('live').textContent = message ? '' : 'Camera is off.'; $('live').classList.remove('live');
  say(message);
  return generation;
}
function resetCounts(announce = false) {
  revision++; tracker = new Tracker(); people = [];
  counter = makeCounters(spot, pixelGeometry(geometry,width || 1280,height || 720),stopSeconds,inSide);
  counts = counter.snapshot(); freeSince = new Map();
  if (announce) announceReset();
  render(); draw();
}
function draw() { if (overlay.width && spot) drawOverlay(overlay,geometry,people,counts,spot,inSide); }
const editor = geometryEditor($('handles'), () => geometry, first => resetCounts(first), value => { editing = value; }, announceReset);
function metric(one,labelOne,detailOne,two,labelTwo,detailTwo) {
  $('count-one').textContent = one; $('label-one').textContent = labelOne; $('detail-one').textContent = detailOne;
  $('count-two').textContent = two; $('label-two').textContent = labelTwo; $('detail-two').textContent = detailTwo;
}
function renderTables() {
  const now = performance.now()/1000, ids = new Set(counts.tables.map(t => t.id));
  for (const [id,row] of tableRows) if (!ids.has(id)) { row.li.remove(); tableRows.delete(id); }
  let longest = 0;
  for (const table of counts.tables) {
    let row = tableRows.get(table.id);
    if (!row) {
      const li = document.createElement('li'), tile = document.createElement('span'), body = document.createElement('span');
      const state = document.createElement('span'), detail = document.createElement('small'), duration = document.createElement('em'), remove = document.createElement('button');
      tile.className = 'tile'; tile.textContent = table.id; body.append(state,detail);
      remove.type = 'button'; remove.className = 'remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label',`Remove table ${table.id}`);
      remove.addEventListener('click', () => {
        geometry.tables = geometry.tables.filter(t => t.id !== table.id); editor.rebuild(); resetCounts(true);
      });
      li.append(tile,body,duration,remove); $('table-list').append(li);
      row = { li,tile,state,detail,duration }; tableRows.set(table.id,row);
    }
    if (table.occupied) freeSince.delete(table.id);
    else if (!freeSince.has(table.id)) freeSince.set(table.id,{ t: now, clock: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    const free = freeSince.get(table.id), minutes = table.occupied ? table.minutesSeated : (now-free.t)/60;
    if (!table.occupied) longest = Math.max(longest,minutes);
    row.tile.className = table.occupied ? 'tile on' : 'tile'; row.state.textContent = table.occupied ? 'Taken' : 'Free';
    row.detail.textContent = table.occupied ? `${table.people} people` : `since ${free.clock}`;
    row.duration.textContent = `${Math.floor(minutes)} min`;
  }
  metric(counts.occupied,`of ${counts.total} tables taken`,counts.fullHouse ? 'full house' : 'not a full house',counts.total-counts.occupied,'tables free',`longest free ${Math.floor(longest)} min`);
}
function render() {
  if (spot === 'walkway') metric(counts.total,'walked past',`${counts.aToB} one way, ${counts.bToA} the other`,counts.stopped.stops,'stopped at the counter',`${stopSeconds} seconds or more`);
  if (spot === 'doorway') metric(counts.in,'walked in','',counts.out,'walked out','');
  if (spot === 'shelf') metric(counts.now,'at the shelf now','',counts.stops,`stopped ${stopSeconds} seconds or more`,'');
  if (spot === 'counter') {
    metric(counts.now,'waiting now','',counts.longest,'longest queue','');
    $('queue-time').textContent = `${(counts.busySeconds/60).toFixed(1)} minutes with 3 or more waiting`;
  }
  if (spot === 'tables') renderTables();
  if (cameraOn) { $('live').classList.add('live'); $('live').textContent = loadingModel ? 'Getting the counter ready' : `Counting ${picturesPerSecond.toFixed(1)} pictures a second`; }
  $('backend-label').textContent = runner && !loadingModel ? `Using ${backend === 'webgpu' ? 'WebGPU' : 'WASM'}.` : 'Counter is getting ready.';
}
function configureSpot(next) {
  spot = next; geometry = initialGeometry(spot); inSide = 1; tableId = 4; width = height = 0;
  picturesCounted = 0; tableRows.clear(); $('table-list').replaceChildren();
  $('spot-title').textContent = titles[spot];
  $('hint').textContent = spot === 'walkway' ? 'Drag the orange line to where people walk past.' : spot === 'tables' ? 'Drag a box onto each table.' : spot === 'doorway' ? 'Drag the line across the doorway.' : spot === 'shelf' ? 'Drag the box onto the shelf.' : 'Drag the box around people waiting to pay.';
  $('stop-control').hidden = !['walkway','shelf'].includes(spot); $('flip-inside').hidden = spot !== 'doorway';
  $('add-table').hidden = spot !== 'tables'; $('tables-card').hidden = spot !== 'tables'; $('queue-time').hidden = spot !== 'counter';
  resetCounts(); editor.rebuild();
}
function cameraError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'Camera access was refused; allow camera access in your browser and try again.';
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'No camera was found; connect a camera and try again.';
  return 'The camera could not start; close other apps using it and try again.';
}
async function waitForPicture(token) {
  const controller = new AbortController(); pictureController = controller;
  await new Promise((resolve,reject) => {
    let playing = false;
    const timeout = setTimeout(() => finish(new Error('Camera timed out')),15000);
    const ready = () => { if (playing && video.readyState >= 2 && video.videoWidth) finish(); };
    const failed = () => finish(new Error('Camera failed'));
    function finish(error) {
      clearTimeout(timeout); video.removeEventListener('loadeddata',ready); video.removeEventListener('resize',ready); video.removeEventListener('error',failed);
      controller.signal.removeEventListener('abort',failed);
      if (pictureController === controller) pictureController = null;
      error ? reject(error) : resolve();
    }
    controller.signal.addEventListener('abort',failed,{ once: true });
    video.addEventListener('loadeddata',ready); video.addEventListener('resize',ready); video.addEventListener('error',failed);
    Promise.resolve(video.play()).then(() => { playing = true; ready(); },failed);
    if (token !== generation) failed();
  });
}
function layoutPicture() {
  const bounds = $('view').getBoundingClientRect?.();
  if (!bounds?.width || !width || !height) return;
  const rect = containedPicture(bounds.width,bounds.height,width,height);
  Object.assign($('picture-rect').style, Object.fromEntries(Object.entries(rect).map(([key,value]) => [key,`${value}px`])));
  editor.position(); draw();
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(layoutPicture).observe($('view'));
window.addEventListener('resize',layoutPicture);
function resizePicture() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h || (width === w && height === h)) return;
  const rotated = width > 0;
  width = w; height = h; overlay.width = w; overlay.height = h; $('view').style.aspectRatio = `${w} / ${h}`;
  resetCounts(rotated); editor.rebuild(); layoutPicture();
}
async function ensureModel(token) {
  const requested = model;
  loadingModel = true; render();
  say(`Getting the counter ready, ${modelSizes[requested]}`);
  const pending = modelQueue.catch(() => {}).then(async () => {
    await frameTask;
    if (token !== generation) return;
    if (runnerModel !== requested || !runner) {
      const previous = runner; runner = null; runnerModel = null;
      await previous?.release();
      runner = await createRunner(requested); runnerModel = requested;
    }
    if (token !== generation) return;
    backend = runner.backend; input.width = runner.inputW; input.height = runner.inputH;
    loadingModel = false; say(''); render();
    clearInterval(rateTimer);
    rateTimer = setInterval(() => { picturesPerSecond = pictureRate(pictureTimes,performance.now()/1000); render(); },250);
    schedule(token);
  });
  modelQueue = pending;
  try { await pending; } catch (error) {
    if (token === generation) { loadingModel = false; clearInterval(rateTimer); say(error.code === 'MODEL_DOWNLOAD' ? 'The counter model could not download; check the model files and reload.' : 'The counter could not start in this browser; reload or try a current browser.'); $('live').textContent = 'Camera is on; counting has not started.'; }
  }
}
function schedule(token) {
  if (token !== generation || !cameraOn) return;
  const run = metadata => {
    frameTask = frame(token,metadata).catch(() => {
      if (token === generation) { clearInterval(rateTimer); say('The counter could not read this picture; choose another counter in More or start again.'); $('live').textContent = 'Camera is on; counting has paused.'; $('restart-camera').hidden = false; }
    });
  };
  if (typeof video.requestVideoFrameCallback === 'function') {
    videoCallback = video.requestVideoFrameCallback((now,metadata) => { videoCallback = null; run(metadata); });
  } else timer = setTimeout(() => { timer = null; run(null); },17);
}
async function frame(token, metadata) {
  if (token !== generation || !cameraOn) return;
  if (video.readyState < 2 || editing) { schedule(token); return; }
  const realTime = performance.now()/1000;
  if (metadata) {
    const stamp = metadata.mediaTime ?? metadata.expectedDisplayTime;
    if (stamp === lastMediaTime) { schedule(token); return; }
    lastMediaTime = stamp;
  } else if (!fallbackNewPicture(video.currentTime,lastVideoTime,realTime,lastRun)) { schedule(token); return; }
  lastVideoTime = video.currentTime; lastRun = realTime;
  const t = metadata ? pictureTime(metadata,lastTime) : Math.max(realTime,lastTime+.000001);
  lastTime = t;
  resizePicture();
  const frameRevision = revision, currentRunner = runner;
  const { ratio,drawW,drawH } = letterbox(width,height,input.width,input.height);
  inputContext.fillStyle = 'rgb(114,114,114)'; inputContext.fillRect(0,0,input.width,input.height);
  inputContext.save();
  if (mirrored) { inputContext.translate(drawW,0); inputContext.scale(-1,1); }
  inputContext.drawImage(video,0,0,drawW,drawH); inputContext.restore();
  const tensor = rgbaToTensor(inputContext.getImageData(0,0,input.width,input.height).data,input.width,input.height);
  const raw = await currentRunner.run(tensor);
  if (token !== generation || !cameraOn) return;
  backend = currentRunner.backend;
  if (frameRevision !== revision || video.videoWidth !== width || video.videoHeight !== height) { schedule(token); return; }
  people = tracker.update(decodeYolox(raw,{ inputW: input.width,inputH: input.height,ratio }),t);
  counter.update(people,t); counts = counter.snapshot(); picturesCounted++;
  const finished = performance.now()/1000;
  pictureTimes = pictureTimes.filter(time => time > finished-3); pictureTimes.push(finished);
  picturesPerSecond = pictureRate(pictureTimes,finished);
  draw(); if (finished-lastRender > .2) { render(); lastRender = finished; }
  schedule(token);
}
async function startCamera() {
  const token = stopCamera(); show('counting'); say('Opening the camera.');
  $('stop-camera').hidden = false; $('restart-camera').hidden = true;
  if (!inputContext || typeof WebAssembly === 'undefined') { say('This browser cannot run the counter; open this page in a current browser.'); return; }
  try {
    if (source === 'wifi') {
      if (!helper || !cameraName) throw new Error('No helper');
      const stop = await helper.attach(video,cameraName);
      if (typeof stop !== 'function') throw new Error('No stop function');
      if (token !== generation) { await stop(); return; }
      helperStop = stop; mirrored = false;
    } else {
      if (!navigator.mediaDevices?.getUserMedia) { say('This browser cannot open the camera; use a current browser on a secure page or the Mac helper.'); $('restart-camera').hidden = false; return; }
      const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
      if (selectedDevice) constraints.video.deviceId = { exact: selectedDevice };
      const next = await navigator.mediaDevices.getUserMedia(constraints);
      if (token !== generation) { next.getTracks().forEach(track => track.stop()); return; }
      stream = next; video.srcObject = stream;
      const settings = stream.getVideoTracks()[0].getSettings();
      selectedDevice = settings.deviceId ?? null; mirrored = settings.facingMode !== 'environment';
      for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (stream === next) stopCamera('The camera disconnected; reconnect it and start again.'); });
    }
    video.classList.toggle('mirrored',mirrored); cameraOn = true;
    await waitForPicture(token); if (token !== generation) return;
    resizePicture(); resetCounts();
    if (source === 'device') {
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch { devices = []; }
      if (token !== generation) return;
      $('switch-camera').hidden = devices.length < 2;
    }
    await ensureModel(token);
  } catch (error) {
    if (token !== generation) return;
    stopCamera(source === 'wifi' ? 'The Wi-Fi camera could not connect; check its address and the Mac helper, then try again.' : cameraError(error));
  }
}
async function chooseSpot(next) { stopCamera(); configureSpot(next); await startCamera(); }
async function refreshCameras() {
  const result = await helper.listCameras();
  const cameras = Array.isArray(result) ? result : Array.isArray(result?.cameras) ? result.cameras : Object.keys(result ?? {});
  $('saved-cameras').replaceChildren();
  cameras.forEach((camera,i) => {
    const name = typeof camera === 'string' ? camera : camera.name;
    if (typeof name !== 'string') return;
    const li = document.createElement('li'), use = document.createElement('button'), remove = document.createElement('button');
    use.className = remove.className = 'chip'; use.textContent = `Use camera ${i+1}`; remove.textContent = 'Remove';
    remove.setAttribute('aria-label',`Remove camera ${i+1}`);
    use.addEventListener('click', () => { cameraName = name; source = 'wifi'; if (spot) void startCamera(); else { show('start'); say('Pick where this camera points.'); } });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await helper.removeCamera(name); if (cameraName === name) { stopCamera(); cameraName = null; source = 'device'; } await refreshCameras(); }
      catch { say('The camera could not be removed; check the Mac helper and try again.'); remove.disabled = false; }
    });
    li.append(use,remove); $('saved-cameras').append(li);
  });
}
async function discoverHelper() {
  try {
    const candidate = await import('./cctv.js');
    if (!await candidate.helperAvailable()) return;
    helper = candidate; $('wifi-choice').disabled = false; $('helper-state').textContent = 'Helper is running on this Mac';
  } catch { helper = null; }
}
for (const button of document.querySelectorAll('[data-spot]')) button.addEventListener('click', () => { void chooseSpot(button.dataset.spot); });
$('choose-source').addEventListener('click', async () => {
  stopCamera(); show('source'); say('');
  helperReady ??= discoverHelper();
  await helperReady;
  if (helper && screen === 'source') { try { await refreshCameras(); } catch { say('The camera list could not load; check the Mac helper and try again.'); } }
});
$('source-back').addEventListener('click', () => { stopCamera(); show('start'); say(''); });
$('device-source').addEventListener('click', () => { source = 'device'; cameraName = null; show('start'); say(''); });
$('camera-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!helper) return;
  const address = $('camera-address').value.trim(); $('camera-address').value = '';
  if (!address) { say("Type the camera's address."); return; }
  const token = generation; $('connect-camera').disabled = true;
  try {
    const added = await helper.addCamera(address);
    if (token !== generation || screen !== 'source') return;
    const name = typeof added === 'string' ? added : added?.name;
    if (typeof name !== 'string' || !name) throw new Error('No camera name');
    $('camera-address').value = added.address ?? '';
    cameraName = name; source = 'wifi';
    if (spot) await startCamera(); else { show('start'); say('Pick where this camera points.'); }
  } catch { if (token === generation) say('The camera could not be added; check its address and the Mac helper, then try again.'); }
  finally { $('connect-camera').disabled = false; }
});
$('change-spot').addEventListener('click', () => { stopCamera(); show('start'); say(''); });
$('stop-camera').addEventListener('click', () => { stopCamera(); $('restart-camera').focus(); });
$('restart-camera').addEventListener('click', () => { void startCamera(); });
$('switch-camera').addEventListener('click', () => {
  const current = devices.findIndex(d => d.deviceId === selectedDevice);
  selectedDevice = devices[(current+1)%devices.length]?.deviceId ?? null; void startCamera();
});
$('stop-seconds').value = stopSeconds; $('model-choice').value = model;
$('stop-seconds').addEventListener('change', () => { stopSeconds = Number($('stop-seconds').value); resetCounts(); if (cameraOn) say('The seconds setting changed, so the counts have started again.',4000); });
$('flip-inside').addEventListener('click', () => { inSide *= -1; resetCounts(true); });
$('add-table').addEventListener('click', () => { const table = { id: ++tableId,section: 'Room',...nextTableBox(geometry.tables) }; geometry.tables.push(table); editor.rebuild(); editor.select(table); resetCounts(true); });
$('more').addEventListener('click', () => {
  if (typeof $('more-sheet').showModal !== 'function') { say('This browser cannot open the controls; use a current browser and try again.'); return; }
  $('more-sheet').showModal();
});
$('close-more').addEventListener('click', () => $('more-sheet').close());
$('model-choice').addEventListener('change', () => {
  model = $('model-choice').value;
  if (cameraOn) {
    const token = ++generation; cancelPicture(); pictureTimes = []; picturesPerSecond = 0;
    void ensureModel(token);
  }
});
video.addEventListener('error', () => { if (cameraOn) stopCamera('The camera picture stopped; reconnect the camera and start again.'); });
window.addEventListener('pagehide', () => {
  stopCamera();
  modelQueue = modelQueue.catch(() => {}).then(async () => {
    await frameTask;
    const previous = runner; runner = null; runnerModel = null;
    await previous?.release();
  }).catch(() => {});
});
let helperReady = null;
if (Object.hasOwn(titles,params.get('spot'))) void chooseSpot(params.get('spot'));
