import { letterbox, rgbaToTensor, decodeYolox } from './engine/detect.js';
import { Tracker } from './engine/tracker.js';
import { createRunner, modelSizes, modelNames, stepDownTarget } from './ui/model.js';
import { initialGeometry, pixelGeometry, makeCounters, nextTableBox } from './ui/counts.js';
import { geometryEditor, drawOverlay } from './ui/geometry.js';
import { pictureRate, fallbackNewPicture, containedPicture } from './ui/pictures.js';
import { clips } from './videos/clips.js';
import { clipGeometry, repeatTimeline } from './ui/video.js';
const $ = id => document.getElementById(id);
const video = $('video'), overlay = $('overlay');
const titles = { walkway: 'Walkway', doorway: 'Doorway', counter: 'Counter', shelf: 'Shelf', tables: 'Tables' };
const params = new URLSearchParams(location.search);
let modelChosen = Object.hasOwn(modelSizes, params.get('model'));
let model = modelChosen ? params.get('model') : undefined;
let stopSeconds = [5,10,30,60].includes(Number(params.get('stop'))) ? Number(params.get('stop')) : 10;
const defaultStopSeconds = stopSeconds;
let startSource = params.get('source') === 'test' ? 'test' : 'device';
let ownFile = null, ownURL = null, videoRepeats = 0, engineOffset = 0, repeating = false;
const isVideo = () => source === 'test' || source === 'file';
let screen = 'start', spot = null, cameraOn = false, backend = 'wasm';
let picturesCounted = 0, picturesSeen = 0, picturesPerSecond = 0, counts = {};
let lastRunMs = null, lastProblem = '', readySince = null, lastCountAt = null, countingPaused = false;
let generation = 0, revision = 0, stream = null, helperStop = null, source = 'device', cameraName = null;
let helper = null, devices = [], selectedDevice = null, mirrored = false, editing = false;
let geometry = initialGeometry('walkway'), inSide = 1, counter = null, tracker = new Tracker(), people = [];
let runner = null, runnerModel = null, runnerChosen = false, modelQueue = Promise.resolve(), frameTask = Promise.resolve();
let pictureController = null, runnerNotifications = null;
let runTimesMs = [], timedModel = null, steppedDown = 0;
let repeatTask = Promise.resolve();
let timer = null, videoCallback = null, rateTimer = null, noticeTimer = null;
let lastVideoTime = -1, lastRun = -Infinity, lastTime = -Infinity, lastPresentedFrames = 0;
let countedTimes = [], loadingModel = false, width = 0, height = 0, tableId = 4;
let freeSince = new Map(), tableRows = new Map(), lastRender = 0;
const input = document.createElement('canvas'), inputContext = input.getContext('2d', { willReadFrequently: true });
function freezeSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSnapshot));
  return value && typeof value === 'object' ? Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v]) => [k,freezeSnapshot(v)]))) : value;
}
Object.defineProperty(window, '__footfall', { value: Object.freeze({
  get screen() { return screen; }, get spot() { return spot; }, get backend() { return backend; },
  get model() { return model; }, get picturesCounted() { return picturesCounted; },
  get picturesPerSecond() { return pictureRate(countedTimes,performance.now()/1000); }, get counts() { return freezeSnapshot(counts); },
  get cameraOn() { return cameraOn && !isVideo(); },
  get source() { return source; }, get videoRepeats() { return isVideo() ? videoRepeats : 0; },
  get steppedDown() { return steppedDown; },
  get picturesSeen() { return picturesSeen; }, get lastRunMs() { return lastRunMs; }, get lastProblem() { return lastProblem; },
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
  cameraOn = false; loadingModel = false; picturesPerSecond = 0; countedTimes = [];
  lastVideoTime = -1; lastRun = lastTime = -Infinity; lastPresentedFrames = 0;
  readySince = lastCountAt = null; countingPaused = false;
  if (message) lastProblem = message;
  const stop = helperStop; helperStop = null;
  if (stop) { try { Promise.resolve(stop()).catch(() => say('The Wi-Fi camera could not disconnect cleanly; close this tab to finish stopping it.')); } catch { say('The Wi-Fi camera could not disconnect cleanly; close this tab to finish stopping it.'); } }
  for (const track of stream?.getTracks() ?? []) track.stop();
  for (const track of video.srcObject?.getTracks?.() ?? []) track.stop();
  if (ownURL) { URL.revokeObjectURL(ownURL); ownURL = null; }
  repeating = false;
  stream = null; video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  $('stop-camera').hidden = true; $('restart-camera').hidden = false; $('switch-camera').hidden = true;
  $('live').textContent = message ? '' : isVideo() ? 'Video is stopped.' : 'Camera is off.'; $('live').classList.remove('live');
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
  if (cameraOn) {
    const stalled = readySince !== null && performance.now()/1000 - (lastCountAt ?? readySince) >= 5;
    $('live').classList.add('live');
    $('live').textContent = loadingModel ? 'Getting the counter ready'
      : countingPaused ? (isVideo() ? 'Video is playing; counting has paused.' : 'Camera is on; counting has paused.')
      : stalled ? (isVideo() ? 'Video is playing, but no picture has been counted yet. Open More for details.' : 'Camera is on, but no picture has been counted yet. Open More for details.')
      : lastCountAt === null ? (isVideo() ? 'Waiting for the first picture of the video.' : 'Waiting for the first camera picture.')
      : `Counting ${picturesPerSecond.toFixed(1)} pictures a second`;
  }
  $('detail-backend').textContent = runner ? (runner.backend === 'webgpu' ? 'WebGPU' : 'WASM') : 'Getting ready';
  $('detail-model').textContent = model ? `${modelNames[model]} (${modelSizes[model]})` : 'Choosing for this device';
  $('detail-size').textContent = width && height ? `${width} × ${height}` : isVideo() ? 'Waiting for the video' : 'Waiting for the camera';
  $('detail-seen').textContent = picturesSeen;
  $('detail-counted').textContent = picturesCounted;
  $('detail-rate').textContent = pictureRate(countedTimes,performance.now()/1000).toFixed(1);
  $('detail-run').textContent = lastRunMs === null ? 'No count yet' : `${Math.round(lastRunMs)} ms`;
  $('detail-problem').textContent = lastProblem;
  $('detail-problem-row').hidden = !lastProblem;
  $('backend-label').textContent = runner && !loadingModel ? `Using ${backend === 'webgpu' ? 'WebGPU' : 'WASM'}.` : 'Counter is getting ready.';
}
function configureSpot(next) {
  spot = next;
  const clip = source === 'test' ? clips[spot] : null;
  geometry = clipGeometry(spot, clip?.geometry); inSide = clip?.inSide ?? 1;
  stopSeconds = clip?.stopSeconds ?? defaultStopSeconds; $('stop-seconds').value = stopSeconds;
  tableId = Math.max(0,...(geometry.tables ?? []).map(table => Number(table.id))); width = height = 0;
  videoRepeats = 0; engineOffset = 0; updateSourceControls();
  picturesCounted = picturesSeen = 0; lastRunMs = null; tableRows.clear(); $('table-list').replaceChildren();
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
    const failed = () => finish(new Error('Picture unavailable'));
    function finish(error) {
      clearTimeout(timeout); video.removeEventListener('loadeddata',ready); video.removeEventListener('resize',ready); video.removeEventListener('error',failed);
      controller.signal.removeEventListener('abort',failed);
      if (pictureController === controller) pictureController = null;
      error ? reject(error) : resolve();
    }
    controller.signal.addEventListener('abort',failed,{ once: true });
    video.addEventListener('loadeddata',ready); video.addEventListener('resize',ready); video.addEventListener('error',failed);
    Promise.resolve(video.play()).then(() => { playing = true; ready(); },error => finish(error));
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
  const requested = model, chosen = modelChosen;
  loadingModel = true; countingPaused = false; readySince = lastCountAt = null; render();
  say(requested ? `Getting the counter ready, ${modelSizes[requested]}` : 'Getting the counter ready');
  let modelNotice = '';
  const onProblem = message => {
    if (token !== generation) return;
    modelNotice = message; lastProblem = message; say(message); render();
  };
  const notifications = { onProblem, onLoading: name => {
    if (token !== generation) return;
    model = name; $('model-choice').value = name;
    if (loadingModel && !modelNotice) say(`Getting the counter ready, ${modelSizes[name]}`);
    render();
  } };
  const pending = modelQueue.catch(() => {}).then(async () => {
    await frameTask;
    if (token !== generation) return;
    if (runnerModel !== requested || runnerChosen !== chosen || !runner) {
      const previous = runner; runner = null; runnerModel = null;
      runTimesMs = []; timedModel = null;
      await previous?.release();
      runnerNotifications = notifications;
      runner = await createRunner(requested, { modelChosen: chosen,
        onProblem: message => notifications.onProblem(message),
        onLoading: name => notifications.onLoading(name),
      });
      runnerModel = runner.model; runnerChosen = chosen;
    } else {
      // A reused session must report to the current camera generation after Stop or a switch.
      Object.assign(runnerNotifications, notifications);
    }
    if (token !== generation) return;
    backend = runner.backend; model = runner.model; runnerModel = model; $('model-choice').value = model;
    input.width = runner.inputW; input.height = runner.inputH;
    loadingModel = false; readySince = performance.now()/1000;
    if (!modelNotice) say('');
    render();
    clearInterval(rateTimer);
    rateTimer = setInterval(() => { picturesPerSecond = pictureRate(countedTimes,performance.now()/1000); render(); },250);
    schedule(token);
  });
  modelQueue = pending;
  try { await pending; } catch (error) {
    if (token === generation) {
      loadingModel = false; countingPaused = true; readySince = null; clearInterval(rateTimer);
      lastProblem = error.code === 'MODEL_DOWNLOAD' ? 'The counter model could not download; check the model files and reload.' : 'The counter could not start in this browser; reload or try a current browser.';
      say(lastProblem); render(); $('live').textContent = isVideo() ? 'Video is playing; counting has not started.' : 'Camera is on; counting has not started.';
    }
  }
}
function schedule(token) {
  if (token !== generation || !cameraOn || repeating) return;
  const run = metadata => {
    const activeRunner = runner;
    frameTask = frame(token,metadata).catch(error => {
      // Restart may already be waiting for this failed run, even after its camera was stopped.
      if (runner === activeRunner) runnerModel = null;
      if (token !== generation) return;
      countingPaused = true; readySince = null; runnerModel = null;
      backend = runner.backend; model = runner.model; $('model-choice').value = model;
      lastProblem = error.code === 'RUN_TIMEOUT' ? 'This device is taking more than 8 seconds a picture. Open More and choose Fastest.'
        : error.code === 'MODEL_DOWNLOAD' ? 'The counter model could not download; check the model files and reload.'
        : 'The counter could not read this picture; choose another counter in More or start again.';
      say(lastProblem); render(); $('restart-camera').hidden = false;
    });
  };
  if (typeof video.requestVideoFrameCallback === 'function') {
    videoCallback = video.requestVideoFrameCallback((now,metadata) => { videoCallback = null; run(metadata); });
  } else timer = setTimeout(() => { timer = null; run(null); },17);
}
async function frame(token, metadata) {
  if (token !== generation || !cameraOn) return;
  const realTime = performance.now()/1000;
  if (!metadata && !fallbackNewPicture(video.currentTime,lastVideoTime,realTime,lastRun)) { schedule(token); return; }
  // presentedFrames includes deliveries while inference was busy; older browsers only expose observed pictures.
  const presented = metadata?.presentedFrames;
  picturesSeen += Number.isFinite(presented) ? Math.max(1,presented-lastPresentedFrames) : 1;
  if (Number.isFinite(presented)) lastPresentedFrames = presented;
  lastVideoTime = video.currentTime;
  if (video.readyState < 2 || editing) { schedule(token); return; }
  lastRun = realTime;
  const t = Math.max(realTime + engineOffset,lastTime+.000001);
  lastTime = t;
  resizePicture();
  const frameRevision = revision, currentRunner = runner;
  let ratio;
  // A fallback can change input size (Most accurate to Fastest), so capture again for that session.
  const prepare = () => {
    input.width = currentRunner.inputW; input.height = currentRunner.inputH;
    const box = letterbox(width,height,input.width,input.height);
    ratio = box.ratio;
    inputContext.fillStyle = 'rgb(114,114,114)'; inputContext.fillRect(0,0,input.width,input.height);
    inputContext.save();
    if (mirrored) { inputContext.translate(box.drawW,0); inputContext.scale(-1,1); }
    inputContext.drawImage(video,0,0,box.drawW,box.drawH); inputContext.restore();
    return rgbaToTensor(inputContext.getImageData(0,0,input.width,input.height).data,input.width,input.height);
  };
  let raw;
  try { raw = await currentRunner.run(prepare); }
  finally { if (token === generation) lastRunMs = currentRunner.lastRunMs; }
  if (token !== generation || !cameraOn) return;
  backend = currentRunner.backend; model = currentRunner.model; runnerModel = model; $('model-choice').value = model;
  if (frameRevision !== revision || video.videoWidth !== width || video.videoHeight !== height) { schedule(token); return; }
  people = tracker.update(decodeYolox(raw,{ inputW: input.width,inputH: input.height,ratio }),t);
  counter.update(people,t); counts = counter.snapshot(); picturesCounted++;
  const finished = performance.now()/1000; lastCountAt = finished;
  countedTimes = countedTimes.filter(time => time > finished-3); countedTimes.push(finished);
  picturesPerSecond = pictureRate(countedTimes,finished);
  draw(); if (finished-lastRender > .2) { render(); lastRender = finished; }
  if (timedModel !== model) { runTimesMs = []; timedModel = model; }
  runTimesMs.push(lastRunMs);
  // Bound memory for long sessions without discarding the warm-up slots.
  if (runTimesMs.length > 13) runTimesMs.splice(3,runTimesMs.length-13);
  const target = stepDownTarget(runTimesMs,{ model, chosen: modelChosen });
  if (target) { void changeModel(target,true); return; }
  schedule(token);
}
async function changeModel(selected, automatic = false) {
  const tokenBefore = generation, previous = model;
  if (!automatic) modelChosen = true;
  // A repeat must retire its people before a switch resets the counters and generation.
  if (repeating) await repeatTask;
  if (tokenBefore !== generation || (automatic && modelChosen)) return;
  model = selected;
  if (cameraOn) {
    const token = ++generation; cancelPicture(); countedTimes = []; picturesPerSecond = 0;
    resetCounts();
    await ensureModel(token);
    if (automatic && token === generation && !countingPaused && model === selected) {
      steppedDown++;
      say(`This device counts slowly on ${modelNames[previous]} (${modelSizes[previous]}), so the counter switched to ${modelNames[selected]} (${modelSizes[selected]}). You can change it in More.`,8000);
    }
  }
}
async function startCamera() {
  const token = stopCamera(); show('counting'); say(isVideo() ? 'Opening the video.' : 'Opening the camera.');
  updateSourceControls(); videoRepeats = 0; engineOffset = 0; lastProblem = '';
  $('stop-camera').hidden = false; $('restart-camera').hidden = true;
  if (!inputContext || typeof WebAssembly === 'undefined') { say('This browser cannot run the counter; open this page in a current browser.'); return; }
  try {
    if (isVideo()) {
      mirrored = false; video.muted = true; video.playsInline = true; video.playbackRate = 1;
      if (source === 'file') {
        if (!ownFile) throw new Error('No file');
        ownURL = URL.createObjectURL(ownFile); video.src = ownURL;
      } else {
        if (!clips[spot]) throw new Error('No clip');
        video.src = clips[spot].file;
      }
    } else if (source === 'wifi') {
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
    stopCamera(isVideo() ? videoError(error) : source === 'wifi' ? 'The Wi-Fi camera could not connect; check its address and the Mac helper, then try again.' : cameraError(error));
  }
}
function updateStartSource() {
  $('use-camera').setAttribute('aria-pressed', String(startSource === 'device'));
  $('use-test').setAttribute('aria-pressed', String(startSource === 'test'));
  $('source-promise').textContent = startSource === 'test'
    ? 'Plays a test video in this page. Nothing is recorded and nothing leaves this device.'
    : "Uses this device's camera. Nothing is recorded and nothing leaves this device.";
  for (const button of document.querySelectorAll('[data-spot]')) {
    const small = button.querySelector('small');
    button.dataset.description ??= small.textContent;
    button.disabled = startSource === 'test' && !clips[button.dataset.spot];
    small.textContent = button.disabled ? 'No test video for this spot yet' : button.dataset.description;
  }
}
function updateSourceControls() {
  $('source-camera').textContent = source === 'wifi' ? 'Wi-Fi camera' : 'Camera';
  $('source-camera').setAttribute('aria-pressed', String(!isVideo()));
  $('source-test').setAttribute('aria-pressed', String(source === 'test'));
  $('source-file').setAttribute('aria-pressed', String(source === 'file'));
  $('source-test').hidden = !clips[spot];
  $('stop-camera').textContent = isVideo() ? 'Stop the video' : 'Stop and turn the camera off';
  $('counting-screen').classList.toggle('video-source', isVideo());
  $('counting-screen').setAttribute('aria-label', isVideo() ? 'Video and counts' : 'Camera and counts');
  video.setAttribute('aria-label', isVideo() ? 'Video picture' : 'Live camera picture');
  $('video-credit').hidden = !isVideo();
  const credit = clips[spot]?.credit;
  $('video-credit').textContent = isVideo() ? (source === 'test'
    ? (credit ? `Test video: ${credit}` : 'Test video')
    : 'Your own video. It plays on this device and is not uploaded.') + ' The video repeats, so the counts keep growing.' : '';
}
function videoError(error) {
  if (error?.name === 'NotAllowedError') return 'Tap Start counting again to play the video.';
  return source === 'file' ? 'This video could not be played here. Try an MP4 file.'
    : 'The test video could not load; check the connection and try again.';
}
function selectSource(next, file = null) {
  stopCamera(); ownFile = file; source = next;
  if (next === 'device' || next === 'wifi') { startSource = 'device'; updateStartSource(); }
  configureSpot(spot);
  return startCamera();
}
async function chooseSpot(next) {
  if (startSource === 'test' && !clips[next]) return;
  stopCamera(); ownFile = null;
  source = startSource === 'test' ? 'test' : source === 'wifi' ? 'wifi' : 'device';
  configureSpot(next); await startCamera();
}
async function repeatVideo() {
  if (!isVideo() || !cameraOn || repeating) return;
  const token = generation;
  repeating = true; cancelPicture();
  await frameTask;
  if (token !== generation || !cameraOn) return;
  const jump = repeatTimeline(lastTime, performance.now()/1000, engineOffset);
  for (const t of jump.times) { tracker.update([],t); counter.update([],t); }
  engineOffset = jump.offset; lastTime = jump.times.at(-1);
  people = []; counts = counter.snapshot(); draw(); render();
  lastVideoTime = -1; video.currentTime = 0;
  try {
    await waitForPicture(token);
    if (token !== generation) return;
    videoRepeats++; repeating = false;
    if (!loadingModel && !countingPaused && runner) schedule(token);
  } catch (error) { if (token === generation) stopCamera(videoError(error)); }
}

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
    use.addEventListener('click', () => { cameraName = name; startSource = 'device'; updateStartSource(); if (spot) void selectSource('wifi'); else { source = 'wifi'; show('start'); say('Pick where this camera points.'); } });
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
$('device-source').addEventListener('click', () => { stopCamera(); ownFile = null; source = 'device'; startSource = 'device'; updateStartSource(); cameraName = null; show('start'); say(''); });
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
    cameraName = name; startSource = 'device'; updateStartSource();
    if (spot) await selectSource('wifi'); else { source = 'wifi'; show('start'); say('Pick where this camera points.'); }
  } catch { if (token === generation) say('The camera could not be added; check its address and the Mac helper, then try again.'); }
  finally { $('connect-camera').disabled = false; }
});
$('change-spot').addEventListener('click', () => { stopCamera(); ownFile = null; show('start'); say(''); });
$('stop-camera').addEventListener('click', () => { stopCamera(); $('restart-camera').focus(); });
$('restart-camera').addEventListener('click', () => { void startCamera(); });
$('switch-camera').addEventListener('click', () => {
  const current = devices.findIndex(d => d.deviceId === selectedDevice);
  selectedDevice = devices[(current+1)%devices.length]?.deviceId ?? null; void startCamera();
});
$('stop-seconds').value = stopSeconds; $('model-choice').value = model ?? 's';
$('stop-seconds').addEventListener('change', () => { stopSeconds = Number($('stop-seconds').value); resetCounts(); if (cameraOn) say('The seconds setting changed, so the counts have started again.',4000); });
$('flip-inside').addEventListener('click', () => { inSide *= -1; resetCounts(true); });
$('add-table').addEventListener('click', () => { const table = { id: ++tableId,section: 'Room',...nextTableBox(geometry.tables) }; geometry.tables.push(table); editor.rebuild(); editor.select(table); resetCounts(true); });
$('more').addEventListener('click', () => {
  if (typeof $('more-sheet').showModal !== 'function') { say('This browser cannot open the controls; use a current browser and try again.'); return; }
  render(); $('more-sheet').showModal();
});
$('close-more').addEventListener('click', () => $('more-sheet').close());
$('model-choice').addEventListener('change', () => {
  void changeModel($('model-choice').value);
});
$('use-camera').addEventListener('click', () => { startSource = 'device'; source = 'device'; updateStartSource(); });
$('use-test').addEventListener('click', () => { startSource = 'test'; updateStartSource(); });
$('source-camera').addEventListener('click', () => { if (isVideo()) void selectSource('device'); });
$('source-test').addEventListener('click', () => { if (source !== 'test' && clips[spot]) void selectSource('test'); });
$('source-file').addEventListener('click', () => { $('own-video').click(); });
$('own-video').addEventListener('change', () => {
  const file = $('own-video').files?.[0];
  $('own-video').value = '';
  if (file) void selectSource('file', file);
});
video.addEventListener('ended', () => { repeatTask = repeatVideo(); });
video.addEventListener('error', () => { if (cameraOn) stopCamera(isVideo() ? videoError() : 'The camera picture stopped; reconnect the camera and start again.'); });
window.addEventListener('pagehide', () => {
  stopCamera(); ownFile = null;
  modelQueue = modelQueue.catch(() => {}).then(async () => {
    await frameTask;
    const previous = runner; runner = null; runnerModel = null;
    await previous?.release();
  }).catch(() => {});
});
let helperReady = null;
updateStartSource();
if (Object.hasOwn(titles,params.get('spot'))) void chooseSpot(params.get('spot'));
