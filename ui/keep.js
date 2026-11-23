export const HOUR = 3600000, DAY = 24 * HOUR;
export const groupNames = { walkway: 'All walkways', doorway: 'All doorways', counter: 'All counters', shelf: 'All shelves', tables: 'All tables' };
export const mainLabels = { walkway: 'walked past', doorway: 'walked in', shelf: 'stopped at the shelf', counter: 'longest queue', tables: 'most tables taken at once' };

export const spotTitles = { walkway: 'Walkway', doorway: 'Doorway', counter: 'Counter', shelf: 'Shelf', tables: 'Tables' };
export const kindNames = { walkway: 'Walkways', doorway: 'Doorways', counter: 'Counters', shelf: 'Shelves', tables: 'Tables' };
export function cameraNameFor(spot, cameras) {
  const title = spotTitles[spot], used = new Set(cameras.filter(c => c.removedAt === null).map(c => c.name));
  let name = title, suffix = 2;
  while (used.has(name)) name = `${title} ${suffix++}`;
  return name;
}
export function cameraSource(camera) {
  return camera.source === 'wifi' ? `Wi-Fi camera: ${camera.label}` : camera.label || "This device's camera";
}
export function cameraCard(camera, sessions, events, { now, openId }) {
  const own = sessions.filter(s => s.cameraId === camera.id);
  const latest = [...own].sort((a,b) => b.startedAt-a.startedAt)[0];
  const midnight = new Date(now); midnight.setHours(0,0,0,0);
  function moment(at) {
    const date = new Date(at);
    return date.toDateString() === midnight.toDateString() ? clockWords(at)
      : `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]} ${date.getDate()}, ${clockWords(at)}`;
  }
  let status = 'Not counted yet', needsYou = false;
  if (latest) {
    const end = sessionEnd(latest,now,openId), time = moment(end.at);
    status = { counting: `Counting since ${moment(latest.startedAt)}`, stopped: `Stopped by you, ${time}`,
      left: `Stopped, ${time}`, moved: `Stopped, ${time}`, changed: `Stopped, ${time}`, problem: `Stopped by a problem, ${time}`,
      interrupted: `Counting was interrupted, last counted ${time}`, lost: `Stopped without warning, last heard ${time}` }[end.reason];
    needsYou = ['problem','interrupted','lost'].includes(end.reason);
  }
  if (camera.movedAt != null) { status = `Camera moved ${moment(camera.movedAt)}: check the line`; needsYou = true; }
  const summary = summarise(own,events,{ from: midnight.getTime(),to: now+1,step: DAY,now,openId,spot: camera.spot });
  // A first picture can have an event even before a measurable interval has elapsed.
  const hasToday = summary.coveredMs > 0 || own.some(s => s.startedAt >= midnight.getTime() && s.startedAt <= now)
    || events.some(e => e.at >= midnight.getTime() && e.at <= now && own.some(s => s.id === e.sessionId));
  const today = !hasToday ? 'No counts today' : camera.spot === 'counter' ? `Longest queue today: ${summary.main}`
    : camera.spot === 'tables' ? `Most tables taken today: ${summary.main}` : `${summary.main} ${mainLabels[camera.spot]} today`;
  return { status, needsYou, today };
}

export function keptMeasures(spot, counts) {
  switch (spot) {
    case 'walkway': return { sums: { aToB: counts.aToB, bToA: counts.bToA, stops: counts.stopped.stops }, levels: {} };
    case 'doorway': return { sums: { in: counts.in, out: counts.out }, levels: {} };
    case 'shelf': return { sums: { stops: counts.stops }, levels: {} };
    case 'counter': return { sums: { busySeconds: Math.floor(counts.busySeconds) }, levels: { waiting: counts.now } };
    case 'tables': return { sums: {}, levels: { occupied: counts.occupied } };
    default: throw new Error('Unknown spot');
  }
}

export function diffKept(previous, next, at) {
  const rows = [];
  for (const [measure, value] of Object.entries(next.sums)) {
    const n = value - (previous?.sums[measure] ?? 0);
    if (n > 0) rows.push({ at, measure, n });
  }
  for (const [measure, n] of Object.entries(next.levels)) {
    if (previous?.levels[measure] !== n) rows.push({ at, measure, n });
  }
  return rows;
}

export function sessionEnd(session, now, openId) {
  if (session.endedAt !== null) return { at: session.endedAt, reason: session.endReason };
  return session.id === openId ? { at: now, reason: 'counting' } : { at: session.lastAliveAt, reason: 'lost' };
}
const overlap = (a, b, from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from));
export function sessionsInRange(sessions, { from, to, now, openId, spot }) {
  return sessions.filter(s => (!spot || s.spot === spot) && s.startedAt <= to && sessionEnd(s, now, openId).at >= from);
}

export function summarise(sessions, events, { from, to, step, now, openId, spot }) {
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError('Invalid step');
  const selected = sessionsInRange(sessions, { from, to, now, openId, spot });
  const ids = new Set(selected.map(s => s.id));
  const relevant = events.filter(e => ids.has(e.sessionId)).sort((a,b) => a.at-b.at);
  const level = spot === 'counter' ? 'waiting' : spot === 'tables' ? 'occupied' : null;
  const measures = spot === 'walkway' ? ['aToB','bToA'] : spot === 'doorway' ? ['in'] : ['stops'];
  function valueBetween(start, end) {
    const inside = at => at >= start && at < end;
    if (!level) return relevant.reduce((sum,e) => sum + (inside(e.at) && measures.includes(e.measure) ? e.n : 0), 0);
    let peak = 0;
    for (const session of selected) {
      const until = sessionEnd(session, now, openId).at;
      if (session.startedAt >= end || until < start) continue;
      const changes = relevant.filter(e => e.sessionId === session.id && e.measure === level);
      // An interrupted stretch starts with the previous level, without another event row.
      const prior = sessions.filter(s => s.cameraKey === session.cameraKey && ['interrupted','moved'].includes(s.endReason) && s.startedAt < session.startedAt)
        .sort((a,b) => b.startedAt-a.startedAt)[0];
      let current = changes[0]?.at === session.startedAt ? changes[0].n : prior?.totals.levels[level] ?? 0;
      for (const event of changes) if (event.at <= start) current = event.n;
      if (until > start || session.startedAt === start) peak = Math.max(peak, current);
      for (const event of changes) if (inside(event.at)) peak = Math.max(peak, event.n);
    }
    return peak;
  }
  const counted = (start,end) => selected.reduce((sum,s) => sum + overlap(s.startedAt, sessionEnd(s,now,openId).at,start,end),0);
  const rows = [];
  for (let start = from; start < to; start += step) {
    const end = Math.min(start+step,to);
    rows.push({ from: start, value: valueBetween(start,end), countedMs: counted(start,end) });
  }
  return { main: valueBetween(from,to), coveredMs: counted(from,to),
    cameras: new Set(selected.filter(s => overlap(s.startedAt,sessionEnd(s,now,openId).at,from,to) > 0).map(s => s.cameraKey)).size, rows };
}

export function cameraIdentity(spot, source, label = '') {
  const title = spot[0].toUpperCase() + spot.slice(1);
  const name = source === 'device' ? label || "this device's camera" : source === 'wifi' ? 'Wi-Fi camera' : source === 'test' ? 'test video' : 'your own video';
  return { cameraKey: `${spot}|${source}|${source === 'test' ? '' : label}`, cameraName: `${title}, ${name}` };
}
export function durationWords(ms) {
  const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60);
  // A few seconds of counting is not "0 min": zero is kept for no counting at all.
  return hours ? `${hours} h ${minutes % 60} min` : ms > 0 && !minutes ? 'under 1 min' : `${minutes} min`;
}
export function clockWords(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}
export function endWords(end) {
  return { counting: 'Still counting', stopped: 'Stopped by you', left: 'You left the screen',
    moved: `Camera moved about ${clockWords(end.movedAt ?? end.at)}, new session started`,
    changed: 'The line or a setting changed', problem: 'Stopped by a problem',
    interrupted: `Counting was interrupted, last counted ${clockWords(end.at)}`,
    lost: `Stopped without warning, last heard ${clockWords(end.at)}` }[end.reason];
}
export function sessionWords(session, sessions, events, now, openId) {
  const sums = session.totals.sums;
  if (session.spot === 'walkway') return `${sums.aToB+sums.bToA} walked past, ${sums.stops} stopped`;
  if (session.spot === 'doorway') return `${sums.in} walked in, ${sums.out} walked out`;
  if (session.spot === 'shelf') return `${sums.stops} stopped`;
  const at = sessionEnd(session,now,openId).at;
  const peak = summarise(sessions.filter(s => s.id === session.id || (s.cameraKey === session.cameraKey && ['interrupted','moved'].includes(s.endReason))),
    events.filter(e => e.sessionId === session.id), { from: session.startedAt, to: at+1, step: Math.max(1,at+1-session.startedAt), now, openId, spot: session.spot }).main;
  return session.spot === 'counter' ? `longest queue ${peak}` : `most tables taken ${peak}`;
}

function periodSpan(range, now) {
  const first = new Date(now); first.setHours(0,0,0,0);
  first.setDate(first.getDate() - (range === 'month' ? 27 : range === 'week' ? 6 : 0));
  return { from: first.getTime(), to: now+1 };
}

export function comparePeriods(sessions, events, { spot, range = 'today', now, openId }) {
  const current = periodSpan(range,now), first = new Date(current.from);
  first.setDate(first.getDate() - (range === 'month' ? 28 : 7));
  const previousEnd = new Date(now); previousEnd.setDate(previousEnd.getDate()-7);
  const before = { from: first.getTime(), to: range === 'today' ? previousEnd.getTime()+1 : current.from };
  const lastDay = `last ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][first.getDay()]}`;
  const words = range === 'today' ? { title: `Today against ${lastDay}`, now: 'today', before: lastDay,
    missing: `${lastDay} up to this time`, little: 'today' }
    : range === 'week' ? { title: 'These 7 days against the 7 before', now: 'these 7 days', before: 'the 7 days before',
      missing: 'in the 7 days before', little: 'in these 7 days' }
    : { title: 'These 4 weeks against the 4 before', now: 'these 4 weeks', before: 'the 4 weeks before',
      missing: 'in the 4 weeks before', little: 'in these 4 weeks' };
  const level = spot === 'counter' || spot === 'tables';
  function side(span, label) {
    const summary = summarise(sessions,events,{ ...span,step: Math.max(1,span.to-span.from),spot,now,openId });
    if (summary.coveredMs < 10*60000) return null;
    return { text: level ? String(summary.main) : (summary.main/(summary.coveredMs/HOUR)).toFixed(1),
      label: `${mainLabels[spot]}${level ? '' : ' an hour'}, ${label}` };
  }
  const currentSide = side(current,words.now), beforeSide = side(before,words.before);
  return { title: words.title + (level ? '' : ', for each hour counted'), now: currentSide, before: beforeSide,
    none: !beforeSide ? `Nothing was counted ${words.missing}, so there is nothing to compare yet.`
      : !currentSide ? `Too little has been counted ${words.little} to compare yet.` : null };
}

export function historyReport(sessions, events, { selection, week = false, range = week ? 'week' : 'today', now, openId, cameras = [] }) {
  const newest = [...sessions].sort((a,b) => b.startedAt-a.startedAt);
  const options = Object.entries(groupNames).filter(([spot]) => sessions.some(s => s.spot === spot))
    .map(([spot,label]) => ({ value: `group:${spot}`, label, group: 'A group' }));
  const saved = [...cameras].sort((a,b) => a.createdAt-b.createdAt);
  for (const camera of [...saved.filter(c => c.removedAt === null),...saved.filter(c => c.removedAt !== null && sessions.some(s => s.cameraId === c.id))]) {
    options.push({ value: `camera:cam:${camera.id}`, label: camera.name + (camera.removedAt === null ? '' : ' (removed)'), group: 'One camera' });
  }
  const quick = new Map();
  for (const s of newest) if (!s.cameraId && !quick.has(s.cameraKey)) quick.set(s.cameraKey,s.cameraName);
  for (const [key,label] of quick) options.push({ value: `camera:${key}`, label, group: 'One camera' });
  if (!options.some(o => o.value === selection)) selection = newest.length ? `group:${newest[0].spot}` : options[0]?.value ?? '';
  const picked = saved.find(c => selection === `camera:cam:${c.id}`);
  const camera = picked ? { id: picked.id, name: picked.name, kind: spotTitles[picked.spot], source: cameraSource(picked),
    status: cameraCard(picked,sessions,events,{now,openId}).status, removed: picked.removedAt !== null } : null;
  const selected = sessions.filter(s => selection === `group:${s.spot}` || selection === `camera:${s.cameraKey}`);
  const spot = picked?.spot ?? selected[0]?.spot ?? 'walkway';
  const { from,to } = periodSpan(range,now), first = new Date(from);
  const span = { from,to,now,openId,spot };
  const summary = summarise(selected,events,{ ...span, step: Math.max(1,to-from) });
  const list = sessionsInRange(selected,span).sort((a,b) => b.startedAt-a.startedAt);
  let rows;
  if (range !== 'today') {
    // Calendar blocks keep their local midnights through 23- and 25-hour days.
    const days = range === 'month' ? 7 : 1;
    const dateWords = date => `${date.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]}`;
    rows = Array.from({ length: range === 'month' ? 4 : 7 }, (_,i) => {
      const day = new Date(first); day.setDate(day.getDate()+i*days);
      const next = new Date(day); next.setDate(next.getDate()+days);
      const last = new Date(next); last.setDate(last.getDate()-1);
      const start = day.getTime(), end = Math.min(next.getTime(),to);
      const value = summarise(selected,events,{ ...span, from: start,to: end,step: next-start });
      return { from: start, value: value.main, countedMs: value.coveredMs, fullMs: next-start,
        label: range === 'month' ? `${dateWords(day)} to ${dateWords(last)}`
          : `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day.getDay()]} ${day.getDate()}` };
    });
  } else {
    const earliest = list.length ? Math.max(from,Math.min(...list.map(s => s.startedAt))) : to;
    const start = new Date(earliest); start.setMinutes(0,0,0);
    rows = summarise(selected,events,{ ...span, from: start.getTime(),to,step: HOUR }).rows
      .map(row => ({ ...row, fullMs: HOUR, label: `${clockWords(row.from)}` }));
  }
  return { ...summary, rows, options, selection, camera, label: mainLabels[spot],
    compare: comparePeriods(selected,events,{ spot,range,now,openId }),
    covered: `Counted ${durationWords(summary.coveredMs)} in this range${summary.cameras > 1 ? ` across ${summary.cameras} cameras` : ''}`,
    sessions: list.map(s => { const end = sessionEnd(s,now,openId); return { id: s.id,cameraName: saved.find(c => c.id === s.cameraId)?.name ?? s.cameraName,
      time: `${clockWords(s.startedAt)} to ${end.reason === 'counting' ? 'now' : clockWords(end.at)}`,
      end: endWords({ ...end,movedAt: s.movedAt }), totals: sessionWords(s,selected,events,now,openId) }; }) };
}
