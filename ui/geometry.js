const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
export function insideLabel(line, inSide, width = 1, height = 1) {
  const dx = (line.bx - line.ax) * width, dy = (line.by - line.ay) * height;
  if (Math.abs(dx) >= Math.abs(dy)) return (-dx * inSide < 0) ? 'Inside is above the line' : 'Inside is below the line';
  return dy * inSide > 0 ? 'Inside is right of the line' : 'Inside is left of the line';
}
export function geometryEditor(container, getGeometry, changed, dragging, announce = () => changed(true)) {
  let active = null, selected = null, nudgeTimer = null;
  const narrow = () => globalThis.matchMedia?.('(max-width: 899px)').matches ?? false;
  function cancelPending() { clearTimeout(nudgeTimer); nudgeTimer = null; }
  function handles() {
    const geometry = getGeometry(), result = [];
    if (geometry.line) {
      const line = geometry.line;
      result.push({ target: line, mode: 'a', x: line.ax, y: line.ay, label: 'Move line start' },
        { target: line, mode: 'b', x: line.bx, y: line.by, label: 'Move line end' },
        { target: line, mode: 'line', x: (line.ax + line.bx) / 2, y: (line.ay + line.by) / 2, label: 'Move line' });
    }
    for (const [i, box] of (geometry.tables ?? (geometry.zone ? [geometry.zone] : [])).entries()) {
      const name = geometry.tables ? `table ${box.id}` : 'box';
      result.push({ target: box, mode: 'box', x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2, label: `Move ${name}`, i },
        { target: box, mode: 'top', x: box.x1, y: box.y1, label: `Resize ${name} top corner`, i },
        { target: box, mode: 'bottom', x: box.x2, y: box.y2, label: `Resize ${name} bottom corner`, i });
    }
    return result;
  }
  function move(handle, original, dx, dy) {
    const target = handle.target;
    if (handle.mode === 'line') {
      dx = clamp(dx, -Math.min(original.ax, original.bx), 1 - Math.max(original.ax, original.bx));
      dy = clamp(dy, -Math.min(original.ay, original.by), 1 - Math.max(original.ay, original.by));
      for (const end of ['a', 'b']) { target[`${end}x`] = original[`${end}x`] + dx; target[`${end}y`] = original[`${end}y`] + dy; }
    } else if (handle.mode === 'a' || handle.mode === 'b') {
      const end = handle.mode, other = end === 'a' ? 'b' : 'a';
      const x = clamp(original[`${end}x`] + dx), y = clamp(original[`${end}y`] + dy);
      if (Math.hypot(x - target[`${other}x`], y - target[`${other}y`]) >= .05) { target[`${end}x`] = x; target[`${end}y`] = y; }
    } else if (handle.mode === 'box') {
      dx = clamp(dx, -original.x1, 1 - original.x2); dy = clamp(dy, -original.y1, 1 - original.y2);
      target.x1 = original.x1 + dx; target.x2 = original.x2 + dx; target.y1 = original.y1 + dy; target.y2 = original.y2 + dy;
    } else if (handle.mode === 'top') {
      target.x1 = clamp(original.x1 + dx, 0, original.x2 - .06); target.y1 = clamp(original.y1 + dy, 0, original.y2 - .06);
    } else {
      target.x2 = clamp(original.x2 + dx, original.x1 + .06, 1); target.y2 = clamp(original.y2 + dy, original.y1 + .06, 1);
    }
  }
  function position() {
    handles().forEach((handle, i) => {
      const node = container.children[i];
      if (node) {
        node.style.left = `${handle.x * 100}%`;
        node.style.top = `${handle.y * 100}%`;
        node.hidden = narrow() && getGeometry().tables && handle.target !== selected;
      }
    });
    const geometry = getGeometry(), offset = handles().length;
    (geometry.tables ?? []).forEach((box, i) => {
      const node = container.children[offset+i];
      if (!node) return;
      node.hidden = !narrow() || box === selected;
      Object.assign(node.style, { left: `${box.x1*100}%`, top: `${box.y1*100}%`, width: `${(box.x2-box.x1)*100}%`, height: `${(box.y2-box.y1)*100}%` });
    });
  }
  function finish(event) {
    if (!active || (event && event.pointerId !== active.pointerId)) return;
    active = null; dragging(false);
  }
  container.addEventListener('pointermove', event => {
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    move(active.handle, active.original, (event.clientX - active.x) / rect.width, (event.clientY - active.y) / rect.height);
    const moved = JSON.stringify(active.original) !== JSON.stringify(active.handle.target);
    if (moved) { changed(!active.announced); active.announced = true; position(); }
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) container.addEventListener(event, finish);
  return {
    cancelPending,
    position,
    select(box) { selected = box; position(); },
    rebuild() {
      cancelPending(); finish(); container.replaceChildren();
      const tables = getGeometry().tables;
      if (tables && !tables.includes(selected)) selected = tables[0];
      for (const handle of handles()) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = `handle ${['top','bottom'].includes(handle.mode) ? 'resize' : 'move'}`;
        button.setAttribute('aria-label', `${handle.label}; use arrow keys to adjust`);
        button.addEventListener('pointerdown', event => {
          if (event.button !== 0 || active) return;
          event.preventDefault(); cancelPending(); button.focus(); button.setPointerCapture(event.pointerId);
          active = { handle, original: { ...handle.target }, x: event.clientX, y: event.clientY, pointerId: event.pointerId, announced: false };
          dragging(true);
        });
        button.addEventListener('keydown', event => {
          const steps = { ArrowLeft: [-.01,0], ArrowRight: [.01,0], ArrowUp: [0,-.01], ArrowDown: [0,.01] };
          if (!steps[event.key]) return;
          event.preventDefault(); const [dx,dy] = steps[event.key];
          const original = { ...handle.target };
          move(handle, original, dx,dy);
          if (JSON.stringify(original) === JSON.stringify(handle.target)) return;
          changed(false); position(); cancelPending();
          nudgeTimer = setTimeout(() => { nudgeTimer = null; announce(); },1000);
        });
        container.append(button);
      }
      for (const box of tables ?? []) {
        const select = document.createElement('button'); select.type = 'button'; select.className = 'box-select';
        select.setAttribute('aria-label', `Select table ${box.id}`);
        select.addEventListener('click', () => {
          selected = box; position();
          container.children[handles().findIndex(h => h.target === box)]?.focus();
        });
        container.append(select);
      }
      position();
    },
  };
}
export function overlayScale(frameWidth, displayedWidth) {
  return frameWidth / (displayedWidth || frameWidth);
}
export function doorwayLabelRect(line, width, height, textWidth, textHeight) {
  const points = [[line.ax*width,line.ay*height],[line.bx*width,line.by*height],[(line.ax+line.bx)*width/2,(line.ay+line.by)*height/2]];
  const w = Math.min(width,textWidth), h = Math.min(height,textHeight);
  const candidates = [];
  // Handle edges and the midpoint give a small set of nearest clear placements.
  const xs = [0,width-w,(points[2][0]-w/2),...points.flatMap(([x]) => [x-24-w,x+24])];
  const ys = [0,height-h,(points[2][1]-h/2),...points.flatMap(([,y]) => [y-24-h,y+24])];
  const dx = points[1][0]-points[0][0], dy = points[1][1]-points[0][1];
  const clearance = 4*Math.hypot(dx,dy);
  for (const y of ys) for (const x of xs) {
    const sides = [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([cx,cy]) => dx*(cy-points[0][1])-dy*(cx-points[0][0]));
    if (!sides.every(side => side>clearance) && !sides.every(side => side < -clearance)) continue;
    if (x>=0 && y>=0 && x+w<=width && y+h<=height && points.every(([px,py]) => x+w<=px-24 || x>=px+24 || y+h<=py-24 || y>=py+24)) {
      candidates.push({x,y,width:w,height:h});
    }
  }
  const [mx,my] = points[2];
  candidates.sort((a,b) => Math.hypot(a.x+w/2-mx,a.y+h/2-my)-Math.hypot(b.x+w/2-mx,b.y+h/2-my));
  return candidates[0] ?? {x:0,y:0,width:w,height:h};
}
export function drawOverlay(canvas, geometry, people, snapshot, spot, inSide) {
  const context = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
  context.clearRect(0,0,width,height);
  const displayedWidth = canvas.getBoundingClientRect?.().width || width;
  const scale = overlayScale(width,displayedWidth);
  context.lineWidth = 2 * scale; context.font = `600 ${14 * scale}px Helvetica,Arial,sans-serif`;
  const label = (text, x, y) => {
    const measured = context.measureText(text).width;
    x = clamp(x, 3*scale, Math.max(3*scale, width - measured - 3*scale)); y = clamp(y, 16*scale, height - 4*scale);
    context.fillStyle = '#2f2922'; context.fillRect(x - 3*scale, y - 16 * scale, measured + 6*scale, 20 * scale);
    context.fillStyle = '#fff'; context.fillText(text,x,y);
  };
  for (const person of people) {
    context.strokeStyle = '#fff'; context.setLineDash([]);
    context.strokeRect(person.x1,person.y1,person.x2-person.x1,person.y2-person.y1);
    const stayed = (snapshot.stopped?.people ?? snapshot.people ?? []).find(p => p.id === person.id);
    label(stayed ? `${person.id}, here ${Math.floor(stayed.seconds)} s` : String(person.id), person.x1,person.y1-6);
  }
  if (geometry.line) {
    const line = geometry.line;
    context.strokeStyle = '#ff630f'; context.lineWidth = 4 * scale; context.setLineDash([12*scale,8*scale]);
    context.beginPath(); context.moveTo(line.ax*width,line.ay*height); context.lineTo(line.bx*width,line.by*height); context.stroke();
    if (spot === 'doorway') {
      const text = insideLabel(line,inSide,width,height);
      const rect = doorwayLabelRect(line,width/scale,height/scale,context.measureText(text).width/scale+6,20);
      label(text,(rect.x+3)*scale,(rect.y+16)*scale);
    }
  }
  for (const box of geometry.tables ?? (geometry.zone ? [geometry.zone] : [])) {
    const table = snapshot.tables?.find(t => t.id === box.id), occupied = table?.occupied;
    context.strokeStyle = '#fff'; context.lineWidth = 2*scale; context.setLineDash(occupied ? [] : [7*scale,5*scale]);
    if (occupied) { context.fillStyle = 'rgba(255,99,15,.55)'; context.fillRect(box.x1*width,box.y1*height,(box.x2-box.x1)*width,(box.y2-box.y1)*height); }
    context.strokeRect(box.x1*width,box.y1*height,(box.x2-box.x1)*width,(box.y2-box.y1)*height);
    label(table ? occupied ? `${table.id}, ${Math.floor(table.minutesSeated)} min` : `${table.id} free` : spot === 'walkway' ? 'Counter box' : spot === 'shelf' ? 'Shelf box' : 'Queue box',box.x1*width+8,box.y1*height+22*scale);
  }
}
