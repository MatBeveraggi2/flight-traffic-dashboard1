// Page interactive : carte, filtres, clics. Lit les calculs définis dans calcs.js.
// Filtres (dash.params) : airline ("all" ou code), airport (code IATA ou vide), metric ("volume" ou "late").

const MAP = window.MAPDATA;
const fr = d3.formatLocale({ decimal: ',', thousands: ' ', grouping: [3], currency: ['', ''] });
const fInt = fr.format(',d');
const fPct = fr.format('.1%');
const fDec = fr.format(',.1f');
const FORMATS = {
  int: fInt,
  pct: fPct,
  dec: fDec,
  txt: (v) => String(v),
  day: (v) => new Date(v + 'T00:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
};
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// État de la page qui n'est pas un filtre : heure de la carte, lecture, survols.
const S = { t: 600, playing: false, speed: 30, last: null, raf: null, hoverAirport: null, hoverRoute: null, airKey: null, autoplayed: false };
let mapRefs = null;
let airIdx = null;
let planeCache = null;
const arcCache = new Map();

// ---------- filtres ----------

function st() {
  const p = dash.params();
  return { airline: p.airline || 'all', airport: p.airport || '', metric: p.metric === 'late' ? 'late' : 'volume' };
}
const wh = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ---------- lecture des données et états ----------

function failLine(el) {
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  const d = document.createElement('div');
  d.className = 'fl-fail';
  d.textContent = 'Échec du chargement';
  el.appendChild(d);
}

function readAll(ids) {
  const ds = ids.map((id) => dash.data(id));
  if (ds.some((d) => ['error', 'connect', 'declined', 'missing'].includes(d.status))) return 'fail';
  if (ds.some((d) => d.status !== 'ok')) return 'loading';
  return ds.map((d) => d.data);
}

function render(el, ids, draw) {
  const res = readAll(ids);
  if (res === 'fail') return failLine(el);
  if (res === 'loading') {
    el.replaceChildren();
    el.classList.add('dash-skeleton');
    return;
  }
  el.classList.remove('dash-skeleton');
  draw(...res);
}

// Données prêtes ? Sinon on laisse les "—" en place.
function soft(ids, draw) {
  const res = readAll(ids);
  if (Array.isArray(res)) draw(...res);
}

function setVal(el, source, where, field, fmt, value) {
  el.dataset.source = source;
  if (where) el.dataset.where = where; else delete el.dataset.where;
  el.dataset.field = field;
  el.textContent = value === undefined || value === null || Number.isNaN(value) ? '—' : FORMATS[fmt](value);
}

// ---------- outils de dessin ----------

function measure(svg, strings, cls) {
  const t = svg.append('text').attr('class', cls).attr('visibility', 'hidden');
  let m = 0;
  for (const s of strings) {
    t.text(s);
    m = Math.max(m, t.node().getComputedTextLength());
  }
  t.remove();
  return m;
}

function makeTip(el) {
  const tip = document.createElement('div');
  tip.className = 'fl-tip';
  tip.hidden = true;
  el.appendChild(tip);
  return {
    show(ev, title, lines) {
      tip.replaceChildren();
      const t = document.createElement('div');
      t.className = 'fl-tip-t';
      t.textContent = title;
      tip.appendChild(t);
      for (const l of lines) {
        const d = document.createElement('div');
        d.textContent = l;
        tip.appendChild(d);
      }
      tip.hidden = false;
      const b = el.getBoundingClientRect();
      let x = ev.clientX - b.left + 14;
      let y = ev.clientY - b.top + 14;
      if (x + tip.offsetWidth > b.width) x = Math.max(0, ev.clientX - b.left - tip.offsetWidth - 14);
      if (y + tip.offsetHeight > b.height) y = Math.max(0, ev.clientY - b.top - tip.offsetHeight - 14);
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    },
    hide() { tip.hidden = true; },
  };
}

function emptyNote(el, text) {
  el.replaceChildren();
  const d = document.createElement('div');
  d.className = 'fl-empty';
  d.textContent = text;
  el.appendChild(d);
}

function hbar(el, rows, o) {
  el.replaceChildren();
  if (!rows.length) return emptyNote(el, 'Pas assez de vols pour ce classement.');
  const w = Math.max(240, el.clientWidth);
  const rowH = 28, barH = 14, h = rows.length * rowH + 4;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${w} ${h}`)
    .attr('role', 'img').attr('aria-label', o.aria);
  const lw = Math.ceil(measure(svg, rows.map(o.label), 'fl-lbl'));
  const vw = Math.ceil(measure(svg, rows.map((r) => o.fmt(o.value(r))), 'fl-val'));
  const x0 = lw + 10;
  const bw = Math.max(20, w - x0 - vw - 14);
  const x = d3.scaleLinear([0, d3.max(rows, o.value) || 1], [0, bw]);
  const tip = makeTip(el);
  const g = svg.selectAll('g.row').data(rows).join('g').attr('class', 'row')
    .attr('transform', (d, i) => `translate(0,${i * rowH + 2})`);
  g.append('text').attr('class', 'fl-lbl').attr('x', lw).attr('text-anchor', 'end').attr('y', rowH / 2).attr('dy', '0.32em').text(o.label);
  g.append('rect').attr('class', (d) => 'fl-bar' + (o.selected && o.selected(d) ? ' sel' : ''))
    .attr('x', x0).attr('y', (rowH - barH) / 2).attr('height', barH).attr('rx', 4)
    .attr('width', (d) => Math.max(2, x(o.value(d)))).attr('fill', o.color);
  g.append('text').attr('class', 'fl-val').attr('y', rowH / 2).attr('dy', '0.32em')
    .attr('x', (d) => x0 + Math.max(2, x(o.value(d))) + 6).text((d) => o.fmt(o.value(d)));
  g.append('rect').attr('x', 0).attr('y', 0).attr('width', w).attr('height', rowH).attr('fill', 'transparent')
    .style('cursor', o.click ? 'pointer' : null)
    .on('pointermove', function (ev, d) {
      const [title, lines] = o.tip(d);
      svg.classed('fl-hov', true);
      svg.selectAll('.fl-bar').classed('on', (b) => b === d);
      tip.show(ev, title, lines);
      if (o.hover) o.hover(d);
    })
    .on('pointerleave', () => { svg.classed('fl-hov', false); tip.hide(); if (o.hover) o.hover(null); })
    .on('click', (ev, d) => { if (o.click) o.click(d); });
}

function columns(el, rows, o) {
  el.replaceChildren();
  const w = Math.max(280, el.clientWidth), h = 200;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${w} ${h}`)
    .attr('role', 'img').attr('aria-label', o.aria);
  const y = d3.scaleLinear([0, d3.max(rows, o.value) || 1], [h - 24, 10]).nice();
  const ticks = y.ticks(4);
  const lw = Math.ceil(measure(svg, ticks.map(o.fmt), 'fl-tick'));
  const m = { l: lw + 8, r: 4 };
  const x = d3.scaleBand(rows.map((r) => r.hour), [m.l, w - m.r]).paddingInner(0.25);
  svg.selectAll('line.fl-grid-line').data(ticks).join('line').attr('class', 'fl-grid-line')
    .attr('x1', m.l).attr('x2', w - m.r).attr('y1', y).attr('y2', y);
  svg.selectAll('text.fl-tick.y').data(ticks).join('text').attr('class', 'fl-tick y')
    .attr('x', m.l - 6).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text(o.fmt);
  svg.append('line').attr('class', 'fl-axis').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(0)).attr('y2', y(0));
  svg.selectAll('text.fl-tick.x').data(rows.filter((r) => r.hour % 3 === 0)).join('text').attr('class', 'fl-tick x')
    .attr('x', (r) => x(r.hour) + x.bandwidth() / 2).attr('y', h - 6).attr('text-anchor', 'middle').text((r) => `${r.hour} h`);
  const tip = makeTip(el);
  svg.selectAll('rect.fl-bar').data(rows).join('rect').attr('class', 'fl-bar')
    .attr('x', (r) => x(r.hour)).attr('width', x.bandwidth()).attr('rx', 3)
    .attr('y', (r) => y(o.value(r))).attr('height', (r) => Math.max(0, y(0) - y(o.value(r)))).attr('fill', o.color);
  svg.selectAll('rect.hit').data(rows).join('rect').attr('class', 'hit').attr('fill', 'transparent')
    .attr('x', (r) => x(r.hour) - x.step() * 0.125).attr('width', x.step()).attr('y', 0).attr('height', h)
    .on('pointermove', (ev, r) => {
      svg.classed('fl-hov', true);
      svg.selectAll('.fl-bar').classed('on', (b) => b === r);
      const [title, lines] = o.tip(r);
      tip.show(ev, title, lines);
    })
    .on('pointerleave', () => { svg.classed('fl-hov', false); tip.hide(); });
}

function lineChart(el, rows, o) {
  el.replaceChildren();
  const w = Math.max(280, el.clientWidth), h = 200;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${w} ${h}`)
    .attr('role', 'img').attr('aria-label', o.aria);
  const y = d3.scaleLinear([0, d3.max(rows, o.value) || 1], [h - 24, 10]).nice();
  const ticks = y.ticks(4);
  const lw = Math.ceil(measure(svg, ticks.map(o.fmt), 'fl-tick'));
  const m = { l: lw + 8, r: 12 };
  const x = d3.scaleLinear([0, rows.length - 1], [m.l, w - m.r]);
  svg.selectAll('line.fl-grid-line').data(ticks).join('line').attr('class', 'fl-grid-line')
    .attr('x1', m.l).attr('x2', w - m.r).attr('y1', y).attr('y2', y);
  svg.selectAll('text.fl-tick.y').data(ticks).join('text').attr('class', 'fl-tick y')
    .attr('x', m.l - 6).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text(o.fmt);
  svg.selectAll('text.fl-tick.x').data(rows.filter((r) => r.hour % 3 === 0)).join('text').attr('class', 'fl-tick x')
    .attr('x', (r) => x(r.hour)).attr('y', h - 6).attr('text-anchor', 'middle').text((r) => `${r.hour} h`);
  svg.append('path').datum(rows).attr('fill', 'none').attr('stroke', o.color).attr('stroke-width', 2)
    .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
    .attr('d', d3.line().x((r) => x(r.hour)).y((r) => y(o.value(r))));
  const rule = svg.append('line').attr('class', 'fl-ref').attr('y1', 10).attr('y2', h - 24).attr('visibility', 'hidden');
  const dot = svg.append('circle').attr('r', 4).attr('fill', o.color).attr('stroke', 'var(--color-panel)').attr('stroke-width', 2).attr('visibility', 'hidden');
  const tip = makeTip(el);
  svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', w - m.l - m.r).attr('height', h).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const box = svg.node().getBoundingClientRect();
      const sx = ((ev.clientX - box.left) / box.width) * w;
      const i = Math.max(0, Math.min(rows.length - 1, Math.round(x.invert(sx))));
      const r = rows[i];
      rule.attr('x1', x(r.hour)).attr('x2', x(r.hour)).attr('visibility', 'visible');
      dot.attr('cx', x(r.hour)).attr('cy', y(o.value(r))).attr('visibility', 'visible');
      const [title, lines] = o.tip(r);
      tip.show(ev, title, lines);
    })
    .on('pointerleave', () => { rule.attr('visibility', 'hidden'); dot.attr('visibility', 'hidden'); tip.hide(); });
}

// ---------- géométrie de la carte ----------

// Projection Natural Earth 1, identique à d3.geoNaturalEarth1 réglée pour le fond de carte.
function NE(lon, lat) {
  const l = (lon * Math.PI) / 180, p = (lat * Math.PI) / 180, p2 = p * p, p4 = p2 * p2;
  return [
    MAP.tx + MAP.k * l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    MAP.ty - MAP.k * p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
}
function vec(lat, lon) {
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}
function angle(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}
function slerpXY(a, b, ang, f) {
  const s = Math.sin(ang);
  const k0 = Math.sin((1 - f) * ang) / s, k1 = Math.sin(f * ang) / s;
  const x = k0 * a[0] + k1 * b[0], y = k0 * a[1] + k1 * b[1], z = k0 * a[2] + k1 * b[2];
  return NE((Math.atan2(y, x) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI);
}
function arcPath(a, b) {
  const key = a.iata < b.iata ? a.iata + b.iata : b.iata + a.iata;
  if (arcCache.has(key)) return arcCache.get(key);
  const ang = angle(a.v, b.v);
  const n = Math.max(8, Math.ceil(ang * 20));
  let d = '', prevX = null;
  for (let i = 0; i <= n; i++) {
    const [X, Y] = slerpXY(a.v, b.v, ang, i / n);
    d += (prevX === null || Math.abs(X - prevX) > MAP.w / 2 ? 'M' : 'L') + X.toFixed(1) + ' ' + Y.toFixed(1);
    prevX = X;
  }
  arcCache.set(key, d);
  return d;
}

function resolveColor(host, token) {
  const s = document.createElement('span');
  s.style.cssText = 'position:absolute;visibility:hidden';
  s.style.color = token;
  host.appendChild(s);
  const c = getComputedStyle(s).color;
  s.remove();
  return c;
}

function buildPlanes(flights, geo) {
  if (planeCache && planeCache.src === flights) return planeCache.planes;
  const day0 = Date.parse(flights[0].scheduled_dep_utc.slice(0, 10) + 'T00:00:00Z');
  const planes = [];
  for (const f of flights) {
    if (f.status === 'cancelled') continue;
    const o = geo[f.origin], d = geo[f.destination];
    if (!o || !d) continue;
    planes.push({
      t0: (Date.parse(f.actual_dep_utc) - day0) / 60000,
      t1: (Date.parse(f.actual_arr_utc) - day0) / 60000,
      a: o.v, b: d.v, ang: angle(o.v, d.v), delayed: Number(f.dep_delay_min) >= 15, airline: f.airline_code,
    });
  }
  planeCache = { src: flights, planes };
  return planes;
}

// ---------- carte ----------

function updateHighlight() {
  const M = mapRefs;
  if (!M) return;
  const sel = M.st.airport, hov = S.hoverAirport, hr = S.hoverRoute;
  const touches = (r, i) => i && (r.a === i || r.b === i);
  let any = false;
  for (const e of M.arcs) {
    e.active = touches(e.row, sel) || touches(e.row, hov) || (hr && e.row.route === hr);
    if (e.active) any = true;
  }
  for (const e of M.arcs) {
    const wBase = 0.5 + 1.5 * Math.sqrt(e.row.flights / M.maxF);
    if (e.active) {
      e.el.style.display = '';
      e.el.setAttribute('stroke-opacity', '0.9');
      e.el.setAttribute('stroke-width', (wBase + 0.6) * M.u);
    } else if (e.base) {
      e.el.style.display = '';
      e.el.setAttribute('stroke-opacity', any ? '0.07' : '0.28');
      e.el.setAttribute('stroke-width', wBase * M.u);
    } else {
      e.el.style.display = 'none';
    }
  }
}

function paintPlanes() {
  const M = mapRefs;
  if (!M) return;
  const { ctx } = M;
  ctx.clearRect(0, 0, M.canvas.width, M.canvas.height);
  const t = S.t, air = M.st.airline;
  const r = 1.8 * M.dpr;
  const onTime = new Path2D(), late = new Path2D();
  for (const p of M.planes) {
    if (t < p.t0 || t >= p.t1) continue;
    if (air !== 'all' && p.airline !== air) continue;
    const [X, Y] = slerpXY(p.a, p.b, p.ang, (t - p.t0) / (p.t1 - p.t0));
    const px = X * M.sc, py = (Y - MAP.y0) * M.sc;
    const path = p.delayed ? late : onTime;
    path.moveTo(px + r, py);
    path.arc(px, py, r, 0, 6.2832);
  }
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = M.cOnTime;
  ctx.fill(onTime);
  ctx.fillStyle = M.cLate;
  ctx.fill(late);
}

function syncClock() {
  const t = S.t;
  $('t-clock').textContent = `${pad(Math.floor(t / 60))}:${pad(Math.floor(t % 60))} UTC`;
  const rg = $('t-range');
  if (document.activeElement !== rg) rg.value = String(Math.floor(t));
  const airline = mapRefs ? mapRefs.st.airline : 'all';
  const step = Math.min(287, Math.floor(t / 5));
  const key = airline + '|' + step;
  if (airIdx && key !== S.airKey) {
    S.airKey = key;
    const row = airIdx.get(key);
    setVal($('t-air'), 'airborne', wh({ airline, step }), 'in_air', 'int', row ? row.in_air : undefined);
  }
}

function frame(ts) {
  S.raf = null;
  if (!S.playing) { S.last = null; return; }
  if (S.last !== null) S.t = (S.t + ((ts - S.last) / 1000) * S.speed) % 1440;
  S.last = ts;
  syncClock();
  paintPlanes();
  S.raf = requestAnimationFrame(frame);
}

function setPlaying(on) {
  S.playing = on;
  const b = $('t-play');
  b.textContent = on ? 'Pause' : 'Lecture';
  b.setAttribute('aria-pressed', String(on));
  if (on && !S.raf) { S.last = null; S.raf = requestAnimationFrame(frame); }
}

function drawLegend(S0, C) {
  const lg = $('map-legend');
  lg.replaceChildren();
  const item = (swatch, text) => {
    const it = document.createElement('span');
    it.className = 'it';
    if (swatch) it.appendChild(swatch);
    it.appendChild(document.createTextNode(text));
    lg.appendChild(it);
  };
  const dot = (color) => { const d = document.createElement('span'); d.className = 'dot'; d.style.background = color; return d; };
  if (S0.metric === 'late') {
    const ramp = document.createElement('span');
    ramp.className = 'ramp';
    ramp.style.background = `linear-gradient(90deg, ${C.muted}, ${C.orange})`;
    item(ramp, 'Moins de départs en retard, plus de départs en retard');
  } else {
    item(dot(C.blue), 'Aéroport : la taille du cercle suit les mouvements du jour');
  }
  item(dot(C.fg), 'Vol en l’air');
  item(dot(C.orange), 'Vol parti avec 15 minutes de retard ou plus');
}

function selectAirport(iata) {
  dash.setParams({ airport: st().airport === iata ? null : iata });
}

function drawMap(S0, apRows, rtRows, flights, airports) {
  const wrap = $('c-map');
  wrap.replaceChildren();
  const w = Math.max(300, wrap.clientWidth);
  const h = Math.round((w * MAP.h) / MAP.w);
  const u = MAP.w / w; // unités du viewBox par pixel
  wrap.style.height = h + 'px';
  wrap.style.minHeight = h + 'px';

  const C = {
    blue: resolveColor(wrap, dash.colors[0]), orange: resolveColor(wrap, dash.colors[1]),
    fg: resolveColor(wrap, 'var(--color-fg)'), muted: resolveColor(wrap, 'var(--cds-chart-muted)'),
  };

  const geo = {};
  for (const r of apRows) {
    if (r.airline === 'all') geo[r.iata] = { iata: r.iata, city: r.city, v: vec(r.lat, r.lon), xy: NE(r.lon, r.lat) };
  }
  const rows = apRows.filter((r) => r.airline === S0.airline).sort((a, b) => b.movements - a.movements);
  const maxMov = d3.max(rows, (r) => r.movements) || 1;
  const rScale = d3.scaleSqrt([0, maxMov], [3, w < 600 ? 9 : 14]);
  const minDep = S0.airline === 'all' ? 30 : 5;
  const eligible = rows.filter((r) => r.dep_operated >= minDep);
  const ext = d3.extent(eligible, (r) => r.pct_dep_late);
  const ramp = d3.interpolateRgb(C.muted, C.orange);
  const lateColor = (r) => (r.dep_operated < minDep || ext[1] === ext[0] ? C.muted : ramp((r.pct_dep_late - ext[0]) / (ext[1] - ext[0])));

  const svg = d3.select(wrap).append('svg').attr('width', '100%').attr('height', h)
    .attr('viewBox', `0 ${MAP.y0} ${MAP.w} ${MAP.h}`).attr('role', 'img')
    .attr('aria-label', 'Carte du monde des aéroports et des lignes');
  svg.append('path').attr('class', 'fl-land').attr('d', MAP.land).attr('stroke-width', 0.5 * u);

  // lignes : les plus fréquentées en fond, les autres seulement quand on les survole ou les sélectionne
  const rts = rtRows.filter((r) => r.airline === S0.airline && geo[r.a] && geo[r.b]).sort((a, b) => b.flights - a.flights);
  const maxF = rts.length ? rts[0].flights : 1;
  const arcG = svg.append('g');
  const arcs = rts.map((row, i) => {
    const el = arcG.append('path').attr('class', 'fl-arc').attr('stroke', C.blue).attr('d', arcPath(geo[row.a], geo[row.b])).node();
    return { el, row, base: i < 60, active: false };
  });

  // aéroports
  const tip = makeTip(wrap);
  const apG = svg.append('g');
  const nodes = apG.selectAll('g.ap').data(rows).join('g').attr('class', 'fl-ap')
    .attr('transform', (r) => `translate(${geo[r.iata].xy[0].toFixed(1)},${geo[r.iata].xy[1].toFixed(1)})`)
    .attr('tabindex', 0).attr('role', 'button')
    .attr('aria-label', (r) => `${r.city}, ${r.iata}, ${fInt(r.movements)} mouvements`);
  nodes.append('circle').attr('r', (r) => Math.max(rScale(r.movements), 9) * u).attr('fill', 'transparent');
  nodes.append('circle').attr('class', 'dot').attr('r', (r) => rScale(r.movements) * u)
    .attr('fill', (r) => (S0.metric === 'late' ? lateColor(r) : C.blue)).attr('fill-opacity', 0.8)
    .attr('stroke', (r) => (r.iata === S0.airport ? C.fg : 'var(--color-panel)'))
    .attr('stroke-width', (r) => (r.iata === S0.airport ? 2.2 : 1) * u);
  nodes
    .on('pointermove', (ev, r) => {
      S.hoverAirport = r.iata;
      updateHighlight();
      tip.show(ev, `${r.iata} · ${r.city}`, [
        `${fInt(r.movements)} mouvements`, `${fInt(r.departures)} départs, ${fInt(r.arrivals)} arrivées`,
        `${fPct(r.pct_dep_late)} des départs en retard`,
      ]);
    })
    .on('pointerleave', () => { S.hoverAirport = null; updateHighlight(); tip.hide(); })
    .on('click', (ev, r) => selectAirport(r.iata))
    .on('keydown', (ev, r) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectAirport(r.iata); } });

  // étiquettes : les plus actifs et l'aéroport sélectionné, si la carte est assez large
  if (w >= 560) {
    const lab = rows.filter((r, i) => i < 12 || r.iata === S0.airport);
    svg.append('g').selectAll('text').data(lab).join('text').attr('class', 'fl-maplbl')
      .attr('x', (r) => geo[r.iata].xy[0]).attr('y', (r) => geo[r.iata].xy[1] - (rScale(r.movements) + 3) * u)
      .attr('text-anchor', 'middle').attr('font-size', 11 * u).attr('stroke-width', 3 * u).text((r) => r.iata);
  }

  // vols en l'air, sur un canevas au-dessus
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  wrap.appendChild(canvas);

  mapRefs = {
    st: S0, arcs, maxF, u, canvas, ctx: canvas.getContext('2d'), dpr, sc: canvas.width / MAP.w,
    planes: buildPlanes(flights, geo), cOnTime: C.fg, cLate: C.orange,
  };
  S.airKey = null;
  updateHighlight();
  drawLegend(S0, C);
  syncClock();
  paintPlanes();
  if (!S.autoplayed) { S.autoplayed = true; if (!REDUCED) setPlaying(true); }
}

// ---------- contrôles ----------

function syncControls(S0, kpRows) {
  const sel = $('f-airline');
  if (kpRows && sel.options.length !== kpRows.length) {
    const all = kpRows.find((r) => r.airline === 'all');
    const others = kpRows.filter((r) => r.airline !== 'all').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    sel.replaceChildren(...[all, ...others].map((r) => new Option(r.name, r.airline)));
  }
  if (sel.value !== S0.airline) sel.value = S0.airline;
  $('m-volume').setAttribute('aria-pressed', String(S0.metric === 'volume'));
  $('m-late').setAttribute('aria-pressed', String(S0.metric === 'late'));
  $('f-clear').hidden = S0.airline === 'all' && !S0.airport && S0.metric === 'volume';
}

$('f-airline').addEventListener('change', (e) => dash.setParams({ airline: e.target.value }));
$('m-volume').addEventListener('click', () => dash.setParams({ metric: 'volume' }));
$('m-late').addEventListener('click', () => dash.setParams({ metric: 'late' }));
$('f-clear').addEventListener('click', () => dash.setParams({ airline: 'all', airport: null, metric: 'volume' }));
$('p-clear').addEventListener('click', () => dash.setParams({ airport: null }));
$('t-play').addEventListener('click', () => setPlaying(!S.playing));
$('t-speed').addEventListener('change', (e) => { S.speed = Number(e.target.value); });
$('t-range').addEventListener('input', (e) => {
  S.t = Number(e.target.value);
  syncClock();
  paintPlanes();
});

// ---------- bandeau, chiffres clés, phrase ----------

function fillKpis(S0, kp) {
  const row = kp.find((r) => r.airline === S0.airline);
  const w = wh({ airline: S0.airline });
  const put = (id, field, fmt) => setVal($(id), 'kpis_by_airline', w, field, fmt, row ? row[field] : undefined);
  put('k-flights', 'flights', 'int'); put('k-operated', 'operated', 'int');
  put('k-airports', 'airports', 'int'); put('k-routes', 'routes', 'int');
  put('k-late', 'pct_late', 'pct'); put('k-avg', 'avg_late_min', 'dec');
  put('k-cancelled', 'cancelled', 'int'); put('k-diverted', 'diverted', 'int');
  put('k-hours', 'delay_hours', 'int');
  setVal($('t-day'), 'kpis_by_airline', wh({ airline: 'all' }), 'day', 'day', kp.find((r) => r.airline === 'all').day);
}

function fillTake(S0, kp, apRows, rtRows, ranked) {
  const el = $('take');
  el.replaceChildren();
  const k = kp.find((r) => r.airline === S0.airline);
  const topAp = apRows.filter((r) => r.airline === S0.airline).sort((a, b) => b.movements - a.movements || a.iata.localeCompare(b.iata))[0];
  const topRt = rtRows.filter((r) => r.airline === S0.airline).sort((a, b) => b.flights - a.flights || a.route.localeCompare(b.route))[0];
  const add = (text) => el.append(document.createTextNode(text));
  const mark = (source, where, field, fmt, value) => {
    const s = document.createElement('span');
    s.className = 'fl-n';
    setVal(s, source, where, field, fmt, value);
    el.append(s);
  };
  const apW = (r) => wh({ airline: r.airline, iata: r.iata });
  const rtW = (r) => wh({ airline: r.airline, route: r.route });
  if (!k || !topAp || !topRt) return;
  if (S0.airline === 'all') {
    const top = ranked[0];
    mark('airports_by_airline', apW(topAp), 'city', 'txt', topAp.city); add(' (');
    mark('airports_by_airline', apW(topAp), 'iata', 'txt', topAp.iata); add(') concentre le plus de mouvements, ');
    mark('airports_by_airline', apW(topAp), 'movements', 'int', topAp.movements); add('. ');
    mark('airlines_ranked', wh({ code: top.code }), 'name', 'txt', top.name); add(' opère le plus de vols, ');
    mark('airlines_ranked', wh({ code: top.code }), 'flights', 'int', top.flights); add('. La ligne ');
    mark('routes_by_airline', rtW(topRt), 'route', 'txt', topRt.route); add(' est la plus empruntée, avec ');
    mark('routes_by_airline', rtW(topRt), 'flights', 'int', topRt.flights); add(' vols. ');
    mark('kpis_by_airline', wh({ airline: 'all' }), 'pct_late', 'pct', k.pct_late); add(' des vols arrivent avec 15 minutes de retard ou plus.');
  } else {
    mark('kpis_by_airline', wh({ airline: k.airline }), 'name', 'txt', k.name); add(' opère ');
    mark('kpis_by_airline', wh({ airline: k.airline }), 'flights', 'int', k.flights); add(' vols sur ');
    mark('kpis_by_airline', wh({ airline: k.airline }), 'routes', 'int', k.routes); add(' lignes. Son aéroport le plus actif est ');
    mark('airports_by_airline', apW(topAp), 'city', 'txt', topAp.city); add(' (');
    mark('airports_by_airline', apW(topAp), 'iata', 'txt', topAp.iata); add('), ');
    mark('airports_by_airline', apW(topAp), 'movements', 'int', topAp.movements); add(' mouvements. Sa ligne la plus empruntée, ');
    mark('routes_by_airline', rtW(topRt), 'route', 'txt', topRt.route); add(', compte ');
    mark('routes_by_airline', rtW(topRt), 'flights', 'int', topRt.flights); add(' vols. ');
    mark('kpis_by_airline', wh({ airline: k.airline }), 'pct_late', 'pct', k.pct_late); add(' de ses vols arrivent avec 15 minutes de retard ou plus.');
  }
}

// ---------- fiche d'un aéroport ----------

function drawPanel(S0, kp, apRows, rtRows) {
  const panel = $('airport-panel');
  if (!S0.airport) { panel.hidden = true; return; }
  panel.hidden = false;
  const any = apRows.find((r) => r.airline === 'all' && r.iata === S0.airport);
  const row = apRows.find((r) => r.airline === S0.airline && r.iata === S0.airport);
  const names = Object.fromEntries(kp.map((r) => [r.airline, r.name]));
  const city = Object.fromEntries(apRows.filter((r) => r.airline === 'all').map((r) => [r.iata, r.city]));
  $('p-title').textContent = any ? `${any.city} (${any.iata})` : S0.airport;
  $('p-sub').textContent = S0.airline === 'all'
    ? 'Détail de l’aéroport sélectionné, toutes compagnies.'
    : `Détail de l’aéroport sélectionné, pour ${names[S0.airline]}.`;
  $('p-empty').hidden = !!row;
  $('p-body').hidden = !row;
  if (!row) return;
  const w = wh({ airline: row.airline, iata: row.iata });
  setVal($('p-mov'), 'airports_by_airline', w, 'movements', 'int', row.movements);
  setVal($('p-dep'), 'airports_by_airline', w, 'departures', 'int', row.departures);
  setVal($('p-arr'), 'airports_by_airline', w, 'arrivals', 'int', row.arrivals);
  setVal($('p-late'), 'airports_by_airline', w, 'pct_dep_late', 'pct', row.pct_dep_late);

  const dest = rtRows.filter((r) => r.airline === S0.airline && (r.a === S0.airport || r.b === S0.airport))
    .map((r) => ({ ...r, other: r.a === S0.airport ? r.b : r.a }))
    .sort((a, b) => b.flights - a.flights || a.route.localeCompare(b.route)).slice(0, 6);
  render($('p-dest'), ['routes_by_airline'], () => hbar($('p-dest'), dest, {
    aria: 'Principales destinations',
    label: (r) => `${r.other} · ${city[r.other] || r.other}`, value: (r) => r.flights, fmt: fInt, color: dash.colors[0],
    tip: (r) => [r.route, [`${fInt(r.flights)} vols`, `${fInt(r.distance_km)} km`, `${fPct(r.pct_late)} en retard`]],
    hover: (r) => { S.hoverRoute = r ? r.route : null; updateHighlight(); },
    click: (r) => dash.setParams({ airport: r.other }),
  }));
  const comp = apRows.filter((r) => r.iata === S0.airport && r.airline !== 'all')
    .sort((a, b) => b.movements - a.movements || a.airline.localeCompare(b.airline)).slice(0, 6);
  render($('p-air'), ['airports_by_airline'], () => hbar($('p-air'), comp, {
    aria: 'Compagnies présentes',
    label: (r) => names[r.airline] || r.airline, value: (r) => r.movements, fmt: fInt, color: dash.colors[0],
    selected: (r) => r.airline === S0.airline,
    tip: (r) => [names[r.airline] || r.airline, [`${fInt(r.movements)} mouvements`, `${fPct(r.pct_dep_late)} des départs en retard`]],
    click: (r) => dash.setParams({ airline: S0.airline === r.airline ? 'all' : r.airline }),
  }));
}

// ---------- tableau des compagnies ----------

const sortState = { key: 'pct_late', dir: -1 };

function renderTable(S0) {
  const table = $('c-table');
  const wrap = $('c-table-wrap');
  const res = readAll(['airlines_ranked']);
  if (res === 'fail') return failLine(wrap);
  if (res === 'loading') return;
  const rows = [...res[0]].sort((a, b) => {
    const k = sortState.key;
    const c = typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k];
    return c * sortState.dir || a.code.localeCompare(b.code);
  });
  for (const th of table.querySelectorAll('th')) {
    const k = th.querySelector('button').dataset.k;
    th.setAttribute('aria-sort', k === sortState.key ? (sortState.dir > 0 ? 'ascending' : 'descending') : 'none');
  }
  const tbody = table.querySelector('tbody');
  tbody.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.key = r.code;
    if (r.code === S0.airline) tr.className = 'sel';
    for (const v of [r.name, fInt(r.flights), fInt(r.cancelled), fPct(r.pct_late), fDec(r.avg_arr_delay)]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

document.querySelectorAll('#c-table th button').forEach((b) => {
  b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (sortState.key === k) sortState.dir *= -1;
    else { sortState.key = k; sortState.dir = k === 'name' ? 1 : -1; }
    renderTable(st());
  });
});
$('c-table').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (tr) dash.setParams({ airline: st().airline === tr.dataset.key ? 'all' : tr.dataset.key });
});

// ---------- dessin de toute la page ----------

dash.onData(() => {
  const S0 = st();
  const kpRes = readAll(['kpis_by_airline']);
  syncControls(S0, Array.isArray(kpRes) ? kpRes[0] : null);

  const air = readAll(['airborne']);
  if (Array.isArray(air) && (!airIdx || airIdx.src !== air[0])) {
    airIdx = new Map(air[0].map((r) => [r.airline + '|' + r.step, r]));
    airIdx.src = air[0];
    S.airKey = null;
  }

  soft(['kpis_by_airline'], (kp) => fillKpis(S0, kp));
  soft(['kpis_by_airline', 'airports_by_airline', 'routes_by_airline', 'airlines_ranked'], (kp, ap, rt, ranked) => fillTake(S0, kp, ap, rt, ranked));

  render($('c-map'), ['airports_by_airline', 'routes_by_airline', 'flights', 'airports'], (ap, rt, flights, airports) => drawMap(S0, ap, rt, flights, airports));
  soft(['kpis_by_airline', 'airports_by_airline', 'routes_by_airline'], (kp, ap, rt) => drawPanel(S0, kp, ap, rt));

  render($('c-airports'), ['airports_by_airline'], (ap) => hbar($('c-airports'), ap.filter((r) => r.airline === S0.airline)
    .sort((a, b) => b.movements - a.movements || a.iata.localeCompare(b.iata)).slice(0, 10), {
    aria: 'Mouvements par aéroport',
    label: (r) => `${r.iata} · ${r.city}`, value: (r) => r.movements, fmt: fInt, color: dash.colors[0],
    selected: (r) => r.iata === S0.airport,
    tip: (r) => [`${r.iata} · ${r.city}`, [`${fInt(r.movements)} mouvements`, `${fInt(r.departures)} départs, ${fInt(r.arrivals)} arrivées`]],
    click: (r) => selectAirport(r.iata),
  }));

  render($('c-airlines'), ['airlines_ranked'], (rows) => hbar($('c-airlines'), rows.slice(0, 10), {
    aria: 'Vols par compagnie',
    label: (r) => r.name, value: (r) => r.flights, fmt: fInt, color: dash.colors[0],
    selected: (r) => r.code === S0.airline,
    tip: (r) => [`${r.name} · ${r.code}`, [`${fInt(r.flights)} vols`, `${fInt(r.cancelled)} annulés`, `${fPct(r.pct_late)} en retard`]],
    click: (r) => dash.setParams({ airline: S0.airline === r.code ? 'all' : r.code }),
  }));

  render($('c-routes'), ['routes_by_airline'], (rt) => hbar($('c-routes'), rt.filter((r) => r.airline === S0.airline)
    .sort((a, b) => b.flights - a.flights || a.route.localeCompare(b.route)).slice(0, 10), {
    aria: 'Vols par ligne',
    label: (r) => r.route, value: (r) => r.flights, fmt: fInt, color: dash.colors[0],
    tip: (r) => [r.route, [`${fInt(r.flights)} vols`, `${fInt(r.distance_km)} km`, `${fPct(r.pct_late)} en retard`]],
    hover: (r) => { S.hoverRoute = r ? r.route : null; updateHighlight(); },
  }));

  render($('c-hours'), ['hours_by_airline'], (hr) => columns($('c-hours'), hr.filter((r) => r.airline === S0.airline), {
    aria: 'Départs programmés par heure UTC',
    value: (r) => r.departures, fmt: fInt, color: dash.colors[0],
    tip: (r) => [`${r.hour} h UTC`, [`${fInt(r.departures)} départs`]],
  }));

  render($('c-buckets'), ['buckets_by_airline'], (bk) => hbar($('c-buckets'), bk.filter((r) => r.airline === S0.airline).sort((a, b) => a.order - b.order), {
    aria: 'Vols par tranche de retard à l’arrivée',
    label: (r) => r.bucket, value: (r) => r.flights, fmt: fInt, color: dash.colors[1],
    tip: (r) => [r.bucket, [`${fInt(r.flights)} vols`, `${fPct(r.share)} des vols opérés`]],
  }));

  render($('c-latehours'), ['hours_by_airline'], (hr) => lineChart($('c-latehours'), hr.filter((r) => r.airline === S0.airline), {
    aria: 'Part des départs en retard par heure UTC',
    value: (r) => r.pct_dep_late, fmt: fr.format('.0%'), color: dash.colors[1],
    tip: (r) => [`${r.hour} h UTC`, [`${fPct(r.pct_dep_late)} des départs en retard`, `${fInt(r.departures)} départs, retard moyen ${fDec(r.avg_dep_delay)} min`]],
  }));

  const minDep = S0.airline === 'all' ? 150 : 15;
  const minRt = S0.airline === 'all' ? 20 : 5;
  $('n-lateairports').textContent = `Aéroports d’au moins ${minDep} départs opérés, pour éviter les petits échantillons. Cliquer sur une barre pour l’ouvrir.`;
  $('n-laterroutes').textContent = `Lignes d’au moins ${minRt} vols opérés. Survoler une barre montre la ligne sur la carte.`;

  render($('c-lateairports'), ['airports_by_airline'], (ap) => hbar($('c-lateairports'), ap.filter((r) => r.airline === S0.airline && r.dep_operated >= minDep)
    .sort((a, b) => b.pct_dep_late - a.pct_dep_late || a.iata.localeCompare(b.iata)).slice(0, 8), {
    aria: 'Part de départs en retard par aéroport',
    label: (r) => `${r.iata} · ${r.city}`, value: (r) => r.pct_dep_late, fmt: fPct, color: dash.colors[1],
    selected: (r) => r.iata === S0.airport,
    tip: (r) => [`${r.iata} · ${r.city}`, [`${fPct(r.pct_dep_late)} des départs en retard`, `${fInt(r.dep_operated)} départs opérés`, `retard moyen ${fDec(r.avg_dep_delay)} min`]],
    click: (r) => selectAirport(r.iata),
  }));

  render($('c-laterroutes'), ['routes_by_airline'], (rt) => hbar($('c-laterroutes'), rt.filter((r) => r.airline === S0.airline && r.operated >= minRt)
    .sort((a, b) => b.pct_late - a.pct_late || a.route.localeCompare(b.route)).slice(0, 8), {
    aria: 'Part d’arrivées en retard par ligne',
    label: (r) => r.route, value: (r) => r.pct_late, fmt: fPct, color: dash.colors[1],
    tip: (r) => [r.route, [`${fPct(r.pct_late)} des arrivées en retard`, `${fInt(r.operated)} vols opérés`, `retard moyen ${fDec(r.avg_arr_delay)} min`]],
    hover: (r) => { S.hoverRoute = r ? r.route : null; updateHighlight(); },
  }));

  renderTable(S0);
});
