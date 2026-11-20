function nonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
}

function positive(value, name) {
  nonnegative(value, name);
  if (value === 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function rectangle(zone) {
  if (!zone || ![zone.x1, zone.y1, zone.x2, zone.y2].every(Number.isFinite)
    || zone.x2 < zone.x1 || zone.y2 < zone.y1) throw new RangeError('Invalid zone rectangle');
  return { ...zone };
}

function inside(person, zone) {
  const x = (person.x1 + person.x2) / 2, y = (person.y1 + person.y2) / 2;
  return x >= zone.x1 && x <= zone.x2 && y >= zone.y1 && y <= zone.y2;
}

class TimedCounter {
  constructor() { this.time = null; }
  advance(t) {
    if (!Number.isFinite(t) || (this.time !== null && t < this.time)) {
      throw new RangeError('Counter time must be finite and nondecreasing');
    }
    const previous = this.time;
    this.time = t;
    return previous;
  }
}

class LineCounter extends TimedCounter {
  constructor({ line, band = 12, minAge = 3 }) {
    super();
    if (!line || ![line.ax, line.ay, line.bx, line.by].every(Number.isFinite)) throw new RangeError('Invalid line');
    this.line = { ...line };
    this.length = positive(Math.hypot(line.bx - line.ax, line.by - line.ay), 'Line length');
    this.band = nonnegative(band, 'band');
    this.minAge = positive(minAge, 'minAge');
    if (!Number.isInteger(minAge)) throw new RangeError('minAge must be an integer');
    this.people = new Map(); this.inView = 0;
  }

  update(people, t) {
    this.advance(t); this.inView = people.length;
    for (const person of people) {
      let state = this.people.get(person.id);
      if (!state) { state = { age: 0, side: 0, counted: new Set() }; this.people.set(person.id, state); }
      state.age++;
      const { ax, ay, bx, by } = this.line;
      const x = (person.x1 + person.x2) / 2, y = (person.y1 + person.y2) / 2;
      // The reference sign makes left-to-right positive for a top-to-bottom vertical line.
      const distance = ((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / this.length;
      const side = distance > this.band ? 1 : distance < -this.band ? -1 : state.side;
      if (state.side !== 0 && side !== state.side && state.age >= this.minAge) this.cross(state, side);
      state.side = side;
    }
    return this.snapshot();
  }
}

export class WalkwayCounter extends LineCounter {
  constructor(options) { super(options); this.aToB = 0; this.bToA = 0; }
  cross(state, side) {
    if (state.counted.size) return;
    state.counted.add(side);
    if (side === 1) this.aToB++; else this.bToA++;
  }
  snapshot() { return { aToB: this.aToB, bToA: this.bToA, total: this.aToB + this.bToA, inView: this.inView }; }
}

export class DoorwayCounter extends LineCounter {
  constructor({ inSide = 1, ...options }) {
    super(options);
    if (inSide !== 1 && inSide !== -1) throw new RangeError('inSide must be +1 or -1');
    this.inSide = inSide; this.in = 0; this.out = 0;
  }
  cross(state, side) {
    if (state.counted.has(side)) return;
    state.counted.add(side);
    if (side === this.inSide) this.in++; else this.out++;
  }
  snapshot() { return { in: this.in, out: this.out, inView: this.inView }; }
}

export class ZoneStopCounter extends TimedCounter {
  constructor({ zone, stopSeconds = 10, grace = 1.5 }) {
    super(); this.zone = rectangle(zone);
    this.stopSeconds = nonnegative(stopSeconds, 'stopSeconds'); this.grace = nonnegative(grace, 'grace');
    this.stays = new Map(); this.counted = new Set(); this.stops = 0;
  }
  update(people, t) {
    this.advance(t);
    const ids = new Set(people.filter(p => inside(p, this.zone)).map(p => p.id));
    for (const [id, stay] of this.stays) {
      // Check the gap before accepting a returning centre so a sparse update cannot hide an expired grace period.
      if (stay.outsideSince !== null && t - stay.outsideSince > this.grace) {
        this.stays.delete(id); continue;
      }
      if (ids.has(id)) stay.outsideSince = null;
      else stay.outsideSince ??= t;
    }
    for (const id of ids) {
      if (!this.stays.has(id)) this.stays.set(id, { since: t, outsideSince: null });
    }
    for (const [id, stay] of this.stays) {
      if (t - stay.since >= this.stopSeconds && !this.counted.has(id)) {
        this.counted.add(id); this.stops++;
      }
    }
    return this.snapshot();
  }
  snapshot() {
    return { now: this.stays.size, stops: this.stops,
      people: [...this.stays].map(([id, stay]) => ({ id, seconds: this.time - stay.since })) };
  }
}

export class QueueCounter extends TimedCounter {
  constructor({ zone, sampleSeconds = 5, busyAt = 3 }) {
    super(); this.zone = rectangle(zone); this.sampleSeconds = positive(sampleSeconds, 'sampleSeconds');
    this.busyAt = nonnegative(busyAt, 'busyAt');
    this.now = 0; this.longest = 0; this.samples = 0; this.sum = 0; this.busySeconds = 0;
    this.origin = null;
  }
  update(people, t) {
    const previous = this.advance(t), now = people.filter(p => inside(p, this.zone)).length;
    if (previous !== null && this.now >= this.busyAt) this.busySeconds += t - previous;
    if (this.origin === null) { this.origin = t; this.samples = 1; this.sum = now; }
    else {
      const due = Math.floor((t - this.origin) / this.sampleSeconds) + 1;
      const added = Math.max(0, due - this.samples);
      if (added) {
        // Between observations the last known queue is the only available measurement.
        const onBoundary = this.origin + (due - 1) * this.sampleSeconds === t;
        this.sum += added * this.now + (onBoundary ? now - this.now : 0);
        this.samples += added;
      }
    }
    this.now = now; this.longest = Math.max(this.longest, now);
    return this.snapshot();
  }
  snapshot() {
    return { now: this.now, longest: this.longest, samples: this.samples, sum: this.sum,
      average: this.samples ? this.sum / this.samples : 0, busySeconds: this.busySeconds };
  }
}

export class TablesCounter extends TimedCounter {
  constructor({ tables, seatSeconds = 10, emptySeconds = 20, sitGrace = 1.5 }) {
    super(); this.seatSeconds = nonnegative(seatSeconds, 'seatSeconds');
    this.emptySeconds = nonnegative(emptySeconds, 'emptySeconds');
    this.sitGrace = nonnegative(sitGrace, 'sitGrace');
    if (new Set(tables.map(table => table.id)).size !== tables.length) throw new RangeError('Table ids must be unique');
    this.tables = tables.map(table => ({ ...rectangle(table), occupied: false, people: 0,
      seatedSince: null, emptySince: null, sitters: new Map() }));
    this.events = [];
  }
  update(people, t) {
    this.advance(t);
    for (const table of this.tables) {
      const guests = people.filter(p => inside(p, table));
      const ids = new Set(guests.map(p => p.id));
      table.people = guests.length;
      for (const [id, sitter] of table.sitters) {
        if (sitter.outsideSince !== null && t - sitter.outsideSince > this.sitGrace) {
          table.sitters.delete(id); continue;
        }
        if (!ids.has(id)) sitter.outsideSince ??= t;
      }
      for (const id of ids) {
        if (!table.sitters.has(id)) table.sitters.set(id, { since: t, outsideSince: null });
        else table.sitters.get(id).outsideSince = null;
      }
      // A return cannot erase a vacancy whose confirmation deadline already passed between updates.
      if (table.occupied && table.emptySince !== null && t - table.emptySince > this.emptySeconds) {
        this.leave(table, t);
      }
      if (guests.length) {
        table.emptySince = null;
        if (!table.occupied) {
          // A retained timer alone cannot seat a table while a different person walks past.
          const since = Math.min(...[...ids].map(id => table.sitters.get(id).since));
          if (t - since >= this.seatSeconds) {
            table.occupied = true; table.seatedSince = since;
            this.events.push({ type: 'seated', id: table.id, t, minutesSeated: (t - since) / 60 });
          }
        }
      } else if (table.occupied) {
        table.emptySince ??= t;
        if (t - table.emptySince >= this.emptySeconds) {
          this.leave(table, t);
        }
      }
    }
    return this.snapshot();
  }
  leave(table, t) {
    this.events.push({ type: 'left', id: table.id, t,
      minutesSeated: (table.emptySince - table.seatedSince) / 60 });
    table.occupied = false; table.seatedSince = null; table.emptySince = null;
  }
  snapshot() {
    const sections = new Map();
    const tables = this.tables.map(table => {
      if (!sections.has(table.section)) sections.set(table.section, { section: table.section, occupied: 0, total: 0, full: false });
      const section = sections.get(table.section);
      section.total++; section.occupied += Number(table.occupied); section.full = section.occupied === section.total;
      return { id: table.id, section: table.section, occupied: table.occupied, people: table.people,
        seatedSince: table.seatedSince,
        minutesSeated: table.occupied ? ((table.emptySince ?? this.time) - table.seatedSince) / 60 : 0 };
    });
    const occupied = tables.filter(table => table.occupied).length, total = tables.length;
    return { tables, occupied, total, fullHouse: total > 0 && occupied === total,
      sections: [...sections.values()], events: this.events.map(event => ({ ...event })) };
  }
}

export class SlotTotals {
  constructor({ slotSeconds = 900 } = {}) {
    this.slotSeconds = positive(slotSeconds, 'slotSeconds'); this.totals = new Map();
  }
  add(name, n, t) {
    if (typeof name !== 'string' || !name.length || !Number.isFinite(t)) throw new TypeError('Expected an event name and finite time');
    nonnegative(n, 'Event count');
    const start = Math.floor(t / this.slotSeconds) * this.slotSeconds;
    if (!this.totals.has(start)) this.totals.set(start, new Map());
    const counts = this.totals.get(start);
    counts.set(name, (counts.get(name) ?? 0) + n);
  }
  slots() {
    return [...this.totals].sort(([a], [b]) => a - b)
      .map(([start, counts]) => ({ start, end: start + this.slotSeconds, counts: Object.fromEntries(counts) }));
  }
}
