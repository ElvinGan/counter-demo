export const HOUR = 3600000, DAY = 24 * HOUR;
export const groupNames = { walkway: 'All walkways', doorway: 'All doorways', counter: 'All counters', shelf: 'All shelves', tables: 'All tables' };
export const mainLabels = { walkway: 'walked past', doorway: 'walked in', shelf: 'stopped at the shelf', counter: 'longest queue', tables: 'most tables taken at once' };

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
      const prior = sessions.filter(s => s.cameraKey === session.cameraKey && s.endReason === 'interrupted' && s.startedAt < session.startedAt)
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
  const peak = summarise(sessions.filter(s => s.id === session.id || (s.cameraKey === session.cameraKey && s.endReason === 'interrupted')),
    events.filter(e => e.sessionId === session.id), { from: session.startedAt, to: at+1, step: Math.max(1,at+1-session.startedAt), now, openId, spot: session.spot }).main;
  return session.spot === 'counter' ? `longest queue ${peak}` : `most tables taken ${peak}`;
}

export function historyReport(sessions, events, { selection, week = false, now, openId }) {
  const newest = [...sessions].sort((a,b) => b.startedAt-a.startedAt);
  const options = Object.entries(groupNames).filter(([spot]) => sessions.some(s => s.spot === spot))
    .map(([spot,label]) => ({ value: `group:${spot}`, label }));
  const cameras = new Map();
  for (const s of newest) if (!cameras.has(s.cameraKey)) cameras.set(s.cameraKey,s.cameraName);
  for (const [key,label] of cameras) options.push({ value: `camera:${key}`, label });
  if (!options.some(o => o.value === selection)) selection = newest.length ? `group:${newest[0].spot}` : '';
  const selected = sessions.filter(s => selection === `group:${s.spot}` || selection === `camera:${s.cameraKey}`);
  const spot = selected[0]?.spot ?? 'walkway';
  const midnight = new Date(now); midnight.setHours(0,0,0,0);
  const first = new Date(midnight); if (week) first.setDate(first.getDate()-6);
  const from = first.getTime(), to = now+1;
  const range = { from,to,now,openId,spot };
  const summary = summarise(selected,events,{ ...range, step: week ? DAY : HOUR });
  const list = sessionsInRange(selected,range).sort((a,b) => b.startedAt-a.startedAt);
  let rows;
  if (week) {
    // Local days may be 23 or 25 hours. Keep seven calendar labels through clock changes.
    rows = Array.from({ length: 7 }, (_,i) => {
      const day = new Date(first); day.setDate(day.getDate()+i);
      const next = new Date(day); next.setDate(next.getDate()+1);
      const start = day.getTime(), end = Math.min(next.getTime(),to);
      const value = summarise(selected,events,{ ...range, from: start,to: end,step: next-start });
      return { from: start, value: value.main, countedMs: value.coveredMs, fullMs: next-start,
        label: `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day.getDay()]} ${day.getDate()}` };
    });
  } else {
    const earliest = list.length ? Math.max(from,Math.min(...list.map(s => s.startedAt))) : to;
    const start = new Date(earliest); start.setMinutes(0,0,0);
    rows = summarise(selected,events,{ ...range, from: start.getTime(),to,step: HOUR }).rows
      .map(row => ({ ...row, fullMs: HOUR, label: `${clockWords(row.from)}` }));
  }
  return { ...summary, rows, options, selection, label: mainLabels[spot],
    covered: `Counted ${durationWords(summary.coveredMs)} in this range${summary.cameras > 1 ? ` across ${summary.cameras} cameras` : ''}`,
    sessions: list.map(s => { const end = sessionEnd(s,now,openId); return { id: s.id,cameraName: s.cameraName,
      time: `${clockWords(s.startedAt)} to ${end.reason === 'counting' ? 'now' : clockWords(end.at)}`,
      end: endWords(end), totals: sessionWords(s,selected,events,now,openId) }; }) };
}
