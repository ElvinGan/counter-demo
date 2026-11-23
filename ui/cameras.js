import { cameraNameFor, cameraCard, cameraSource, spotTitles, kindNames } from './keep.js';
import { drawSetup, latestPicture } from './history.js';
import { saveProblem } from './store.js';

// The active camera survives video try-outs, but only its own source can update it.
export function cameraBook({ keeper, onProblem, changed = () => {}, now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
  let cameras = [], active = null, make = false;
  const own = source => active && source === active.source;
  function replace(camera) {
    cameras = cameras.some(c => c.id === camera.id) ? cameras.map(c => c.id === camera.id ? camera : c) : [...cameras,camera];
    if (active?.id === camera.id) active = camera;
    changed();
  }
  return {
    get all() { return cameras; }, get active() { return active; },
    get count() { return cameras.filter(c => c.removedAt === null).length; },
    own,
    async load() {
      try { cameras = await keeper.listCameras(); changed(); }
      catch { onProblem(saveProblem); }
    },
    begin(camera = null, eligible = false) { active = camera; make = eligible; },
    counted(config) {
      if (!active && make && ['device','wifi'].includes(config.source)) {
        const { spot,source,label,deviceId,geometry,inSide,stopSeconds } = config;
        active = { id: uuid(),name: cameraNameFor(spot,cameras),spot,source,label,deviceId,
          geometry: structuredClone(geometry),inSide,stopSeconds,createdAt: now(),removedAt: null,movedAt: null };
        make = false; replace(active); void keeper.putCamera(active);
      }
      return own(config.source) ? active : null;
    },
    update(config) {
      if (!own(config.source)) return;
      const { geometry,inSide,stopSeconds,label,deviceId } = config;
      const next = { ...active,geometry: structuredClone(geometry),inSide,stopSeconds,label,deviceId };
      if (JSON.stringify(next) === JSON.stringify(active)) return;
      replace(next); void keeper.putCamera(next);
    },
    markMoved(source, movedAt) {
      if (!own(source) || (active.movedAt ?? null) === movedAt) return;
      const next = { ...active,movedAt }; replace(next); void keeper.putCamera(next);
    },
    async rename(id, text) {
      const name = text.trim().slice(0,40), camera = cameras.find(c => c.id === id);
      if (!name) return 'Type a name for this camera.';
      if (cameras.some(c => c.id !== id && c.removedAt === null && c.name === name)) return 'Another camera already has this name.';
      const next = { ...camera,name };
      if (!await keeper.putCamera(next)) return saveProblem;
      replace(next); return '';
    },
    async remove(id) {
      const next = { ...cameras.find(c => c.id === id),removedAt: now() };
      if (!await keeper.putCamera(next)) return false;
      replace(next); return true;
    },
  };
}

export function camerasScreen({ book, keeper, start, report, say, root = document, now = () => Date.now(), later = setTimeout, cancel = clearTimeout }) {
  const $ = id => root.getElementById(id);
  let filter = 'all', sessions = [], events = [], pictures = [], revision = 0, closeMenu = () => {};
  function node(tag, className, text) {
    const el = root.createElement(tag); el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(className,text,action) {
    const el = node('button',className,text); el.type = 'button'; el.addEventListener('click',action); return el;
  }
  function draw() {
    closeMenu();
    const active = book.all.filter(c => c.removedAt === null).sort((a,b) => a.createdAt-b.createdAt);
    const kinds = Object.keys(kindNames).filter(spot => active.some(c => c.spot === spot));
    if (!kinds.includes(filter)) filter = 'all';
    $('camera-filter').hidden = kinds.length < 2;
    $('camera-filter').replaceChildren(...['all',...kinds].map(kind => {
      const chip = button('chip',kind === 'all' ? 'All' : kindNames[kind],() => { filter = kind; draw(); });
      chip.dataset.kind = kind; chip.setAttribute('aria-pressed',String(filter === kind)); return chip;
    }));
    $('camera-list').replaceChildren(...active.filter(c => filter === 'all' || c.spot === filter).map(camera => {
      const card = cameraCard(camera,sessions,events,{ now: now(),openId: keeper.sessionId });
      const li = node('li',card.needsYou ? 'needs-you' : ''); if (camera.movedAt != null) li.className += ' camera-moved'; li.dataset.camera = camera.id; li.dataset.spot = camera.spot;
      const open = button('camera-open','',() => report(`camera:cam:${camera.id}`));
      const thumb = node('canvas','camera-thumb'), picture = latestPicture(pictures,camera.id);
      drawSetup(thumb,picture,sessions.find(s => s.id === picture?.sessionId)?.geometry); open.append(thumb);
      open.append(node('b','camera-name',camera.name),node('span','kind',spotTitles[camera.spot]),node('span','src',cameraSource(camera)));
      const menu = node('div','camera-menu'); menu.hidden = true;
      const form = node('form','camera-rename-form'); form.hidden = true;
      const input = node('input','camera-name-input'); input.value = camera.name; input.maxLength = 40; input.setAttribute('aria-label','Camera name');
      const save = node('button','chip','Save'); save.type = 'submit'; form.append(input,save);
      form.addEventListener('submit',async event => {
        event.preventDefault(); save.disabled = true;
        const message = await book.rename(camera.id,input.value); save.disabled = false; say(message);
        if (!message) { draw(); $('cameras-title').focus(); }
      });
      let until = 0, timer = null;
      const remove = button('camera-remove','Remove',async () => {
        if (until > now()) {
          disarm(); remove.disabled = true;
          if (await book.remove(camera.id)) { draw(); $('cameras-title').focus(); }
          else remove.disabled = false;
        } else {
          disarm(); until = now()+5000;
          remove.textContent = 'Tap again to remove this camera; its counts stay in History'; timer = later(disarm,5000);
        }
      });
      function disarm() { until = 0; cancel(timer); timer = null; remove.textContent = 'Remove'; }
      const more = button('camera-more chip','···',() => {
        const opening = menu.hidden; closeMenu();
        menu.hidden = !opening; more.setAttribute('aria-expanded',String(opening));
        closeMenu = () => { menu.hidden = true; form.hidden = true; more.setAttribute('aria-expanded','false'); disarm(); };
      });
      more.setAttribute('aria-label',`More for ${camera.name}`); more.setAttribute('aria-expanded','false');
      menu.append(button('camera-rename','Rename',() => { form.hidden = false; input.focus(); }),
        button('camera-line','Change the line',() => start(camera)),remove);
      li.append(open,more,node('p','camera-status',card.status),node('p','camera-today',card.today),
        button('camera-count btn','Start counting',() => start(camera)),menu,form);
      return li;
    }));
  }
  return {
    close() { revision++; closeMenu(); },
    async open() {
      filter = 'all'; const current = ++revision;
      try {
        const [data, stills] = await Promise.all([keeper.read(),keeper.listPictures()]);
        if (revision !== current) return;
        sessions = data.sessions; events = data.events; pictures = stills; draw();
      } catch { if (revision === current) say('History could not be read on this device. Try opening it again.'); }
    },
  };
}
