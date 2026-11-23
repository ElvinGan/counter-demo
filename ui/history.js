import { historyReport, durationWords } from './keep.js';

export function historyScreen({ keeper, back, onProblem, start = () => {}, root = document, now = () => Date.now(),
  later = setTimeout, cancel = clearTimeout }) {
  const $ = id => root.getElementById(id);
  let sessions = [], events = [], cameras = [], camera = null, selection = '', week = false, armedUntil = 0, timer = null, revision = 0;
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
    $('range-today').setAttribute('aria-pressed',String(!week)); $('range-week').setAttribute('aria-pressed',String(week));
    const report = historyReport(sessions,events,{ selection,week,now: now(),openId: keeper.sessionId, cameras });
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
    const none = camera && !sessions.some(s => s.cameraId === camera.id);
    $('history-none').hidden = !none;
    $('history-bars').hidden = empty || Boolean(none);
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
        if (row.countedMs < row.fullMs-60000) { detail.textContent = `counted ${durationWords(row.countedMs)}`; li.append(detail); }
      }
      return li;
    }));
    $('history-sessions').replaceChildren(...report.sessions.map(session => {
      const li = node('li'); li.dataset.session = session.id;
      li.append(node('b',session.time),node('span',session.end),node('span',session.cameraName),node('span',session.totals));
      return li;
    }));
  }
  async function refresh() {
    const current = ++revision;
    try {
      const [data, saved] = await Promise.all([keeper.read(),keeper.listCameras()]);
      if (current !== revision) return;
      sessions = data.sessions; events = data.events; cameras = saved; draw();
    } catch { if (current === revision) onProblem('History could not be read on this device. Try opening it again.'); }
  }
  $('history-count').addEventListener('click',() => { if (camera && !camera.removed) start(cameras.find(c => c.id === camera.id)); });
  $('history-back').addEventListener('click',() => { revision++; disarm(); back(); });
  $('history-what').addEventListener('change',() => { selection = $('history-what').value; draw(); });
  $('range-today').addEventListener('click',() => { week = false; draw(); });
  $('range-week').addEventListener('click',() => { week = true; draw(); });
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
  return { close() { revision++; disarm(); }, open({ select = '' } = {}) { selection = select; week = false; disarm(); return refresh(); } };
}
