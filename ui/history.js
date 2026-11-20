import { historyReport, durationWords } from './keep.js';

export function historyScreen({ keeper, back, onProblem, root = document, now = () => Date.now(),
  later = setTimeout, cancel = clearTimeout }) {
  const $ = id => root.getElementById(id);
  let sessions = [], events = [], selection = '', week = false, armedUntil = 0, timer = null, revision = 0;
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
    const empty = sessions.length === 0;
    $('history-empty').hidden = !empty;
    for (const id of ['history-what','history-bars','history-sessions','history-summary','history-ranges','history-what-label','clear-history']) $(id).hidden = empty;
    $('range-today').setAttribute('aria-pressed',String(!week)); $('range-week').setAttribute('aria-pressed',String(week));
    const report = historyReport(sessions,events,{ selection,week,now: now(),openId: keeper.sessionId });
    selection = report.selection;
    $('history-what').replaceChildren(...report.options.map(option => {
      const element = node('option',option.label); element.value = option.value; return element;
    }));
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
      const data = await keeper.read();
      if (current !== revision) return;
      sessions = data.sessions; events = data.events; draw();
    } catch { if (current === revision) onProblem('History could not be read on this device. Try opening it again.'); }
  }
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
  return { open() { selection = ''; week = false; disarm(); return refresh(); } };
}
