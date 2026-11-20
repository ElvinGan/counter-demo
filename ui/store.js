import { keptMeasures, diffKept, cameraIdentity } from './keep.js';

export const saveProblem = 'Counts could not be saved on this device; they are still shown here.';
const copy = value => structuredClone(value);
function plain(value) {
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { value.forEach(plain); return; }
  if (value && Object.getPrototypeOf(value) === Object.prototype) { Object.values(value).forEach(plain); return; }
  throw new TypeError('Only plain count records can be kept');
}
function records(session, events) {
  const only = (value, keys) => {
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Unknown count field');
  };
  const fields = ['id','cameraKey','cameraName','spot','source','startedAt','lastAliveAt','endedAt','endReason','geometry','inSide','stopSeconds','model','totals'];
  if (Object.keys(session).some(key => !fields.includes(key))) throw new TypeError('Unknown session field');
  plain(session);
  only(session.geometry,['line','zone','tables']);
  if (session.geometry.line) only(session.geometry.line,['ax','ay','bx','by']);
  if (session.geometry.zone) only(session.geometry.zone,['x1','y1','x2','y2']);
  for (const table of session.geometry.tables ?? []) only(table,['id','section','x1','y1','x2','y2']);
  only(session.totals,['sums','levels']);
  only(session.totals.sums,['aToB','bToA','stops','in','out','busySeconds']);
  only(session.totals.levels,['waiting','occupied']);
  for (const n of [...Object.values(session.totals.sums),...Object.values(session.totals.levels)]) {
    if (typeof n !== 'number') throw new TypeError('Measures must be numbers');
  }
  for (const event of events) {
    if (Object.keys(event).some(key => !['sessionId','at','measure','n'].includes(key))) throw new TypeError('Unknown event field');
    plain(event);
  }
  return copy({ session, events });
}
function byRange(sessions, events, { from = -Infinity, to = Infinity } = {}) {
  const selected = sessions.filter(s => s.startedAt <= to && (s.endedAt ?? s.lastAliveAt) >= from);
  const ids = new Set(selected.map(s => s.id));
  // Include each selected session's earlier levels so ranges can carry a level forward.
  return { sessions: selected, events: events.filter(e => ids.has(e.sessionId)) };
}

export function memoryStore() {
  const sessions = new Map(); let events = [];
  return {
    async write(session, rows = []) {
      const data = records(session,rows);
      sessions.set(session.id,data.session); events.push(...data.events);
    },
    async read(range) { return copy(byRange([...sessions.values()],events,range)); },
    async clear() { sessions.clear(); events = []; },
  };
}

export function deviceStore() {
  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve,reject) => {
        const request = indexedDB.open('footfall',1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('sessions',{ keyPath: 'id' });
          db.createObjectStore('events',{ autoIncrement: true }).createIndex('sessionId','sessionId');
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Count storage is busy'));
      }).catch(error => { opening = null; throw error; });
    }
    return opening;
  }
  async function transaction(mode, work) {
    const db = await open();
    return new Promise((resolve,reject) => {
      const tx = mode === 'readwrite' ? db.transaction(['sessions','events'],mode,{ durability: 'strict' })
        : db.transaction(['sessions','events'],mode);
      let result;
      tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Count storage failed'));
      try { result = work(tx.objectStore('sessions'),tx.objectStore('events')); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    write(session, rows = []) {
      const data = records(session,rows);
      return transaction('readwrite',(sessions,events) => {
        sessions.put(data.session);
        for (const row of data.events) events.add(row);
      });
    },
    read(range) {
      return transaction('readonly',(sessions,events) => {
        const allSessions = sessions.getAll(), allEvents = events.getAll();
        return () => byRange(allSessions.result,allEvents.result,range);
      });
    },
    clear() { return transaction('readwrite',(sessions,events) => { sessions.clear(); events.clear(); }); },
  };
}

// One queue owns all writes, including ends, stamps and history deletion.
export function sessionKeeper({ store, onProblem = () => {}, now = () => Date.now(),
  uuid = () => crypto.randomUUID(), persist = () => globalThis.navigator?.storage?.persist?.(),
  every = setInterval, cancel = clearInterval }) {
  let open = null, previous = null, lastPicture = null, stampAt = null;
  let chain = Promise.resolve(), eventsKept = 0, asked = false, timer = null;
  function enqueue(work) {
    chain = chain.then(work).catch(() => { onProblem(saveProblem); });
    return chain;
  }
  function write(rows = []) {
    const session = copy(open), events = rows.map(row => ({ sessionId: session.id, ...row }));
    enqueue(async () => { await store.write(session,events); eventsKept += events.length; });
  }
  function end(reason, at = now()) {
    if (!open) return;
    open.endedAt = at; open.endReason = reason; write();
    open = null; previous = null; lastPicture = stampAt = null; cancel(timer); timer = null;
  }
  function alive() {
    const at = now();
    if (open && at-stampAt >= 10000 && at-lastPicture <= 10000) {
      open.lastAliveAt = at; stampAt = at; write();
    }
  }
  return {
    get sessionId() { return open?.id ?? null; },
    get eventsKept() { return eventsKept; },
    counted(config, counts, beforeCounts) {
      const at = now();
      let baseline = previous;
      if (open && at-lastPicture > 30000) {
        baseline = keptMeasures(config.spot,beforeCounts);
        end('interrupted',open.lastAliveAt);
      }
      const next = keptMeasures(config.spot,counts);
      const starting = !open;
      if (starting) {
        const { spot,source,label,geometry,inSide,stopSeconds,model } = config;
        open = { id: uuid(), ...cameraIdentity(spot,source,label), spot,source,
          startedAt: at,lastAliveAt: at,endedAt: null,endReason: null,
          geometry: copy(geometry),inSide,stopSeconds,model,totals: next };
        stampAt = at;
        timer = every(alive,10000);
        if (!asked) {
          asked = true;
          try { Promise.resolve(persist()).catch(() => {}); } catch {}
        }
      }
      const rows = diffKept(baseline,next,at);
      open.totals = next;
      if (starting || rows.length) { open.lastAliveAt = at; write(rows); }
      previous = next; lastPicture = at;
    },
    alive,
    end,
    async read(range) { await chain; return store.read(range); },
    clear() { return enqueue(async () => { await store.clear(); open = null; previous = null; lastPicture = stampAt = null; cancel(timer); timer = null; }); },
    flushed() { return chain; },
  };
}
