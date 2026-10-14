// Calculs du dashboard : chaque indicateur est recalculé depuis les lignes de vols brutes.
// Mêmes définitions que src/compute_metrics.py (retard = 15 minutes ou plus, annulés exclus des retards).
// Chaque table contient une ligne "all" (toutes compagnies) et une par compagnie : la page choisit la
// tranche selon le filtre sans rien recalculer.

dash.calc('kpis_by_airline', {
  inputs: ['flights'],
  title: 'Chiffres clés par compagnie',
  description: 'Vols, annulations, aéroports, lignes et retards, pour toutes les compagnies et pour chacune.',
  fn: (flights) => {
    const names = { all: 'Toutes les compagnies' };
    const acc = {};
    for (const f of flights) {
      names[f.airline_code] = f.airline_name;
      for (const k of ['all', f.airline_code]) {
        const a = (acc[k] ??= { flights: 0, cancelled: 0, diverted: 0, late: 0, lateMin: 0, delay: 0, ap: new Set(), rt: new Set() });
        a.flights++;
        a.ap.add(f.origin);
        a.ap.add(f.destination);
        a.rt.add([f.origin, f.destination].sort().join(' ↔ '));
        if (f.status === 'diverted') a.diverted++;
        if (f.status === 'cancelled') { a.cancelled++; continue; }
        const d = Number(f.arr_delay_min);
        if (d >= 15) { a.late++; a.lateMin += d; }
        if (d > 0) a.delay += d;
      }
    }
    const day = flights[0].scheduled_dep_utc.slice(0, 10);
    return Object.keys(acc).map((k) => {
      const a = acc[k];
      const op = a.flights - a.cancelled;
      return {
        airline: k, name: names[k], day, flights: a.flights, operated: op, cancelled: a.cancelled, diverted: a.diverted,
        airports: a.ap.size, routes: a.rt.size, pct_late: a.late / op, avg_late_min: a.late ? a.lateMin / a.late : 0, delay_hours: a.delay / 60,
      };
    });
  },
});

dash.calc('airports_by_airline', {
  inputs: ['flights', 'airports'],
  title: 'Aéroports par compagnie',
  description: 'Départs, arrivées et retards au départ par aéroport, pour toutes les compagnies et pour chacune.',
  fn: (flights, airports) => {
    const geo = Object.fromEntries(airports.map((a) => [a.iata, a]));
    const acc = {};
    const get = (k, i) => (acc[k + '|' + i] ??= { airline: k, iata: i, departures: 0, arrivals: 0, depOp: 0, depLate: 0, depSum: 0 });
    for (const f of flights) {
      for (const k of ['all', f.airline_code]) {
        const o = get(k, f.origin);
        o.departures++;
        get(k, f.destination).arrivals++;
        if (f.status === 'cancelled') continue;
        o.depOp++;
        const d = Number(f.dep_delay_min);
        o.depSum += d;
        if (d >= 15) o.depLate++;
      }
    }
    return Object.values(acc).map((a) => ({
      airline: a.airline, iata: a.iata, city: geo[a.iata].city, lat: Number(geo[a.iata].lat), lon: Number(geo[a.iata].lon),
      departures: a.departures, arrivals: a.arrivals, movements: a.departures + a.arrivals, dep_operated: a.depOp,
      pct_dep_late: a.depOp ? a.depLate / a.depOp : 0, avg_dep_delay: a.depOp ? a.depSum / a.depOp : 0,
    }));
  },
});

dash.calc('routes_by_airline', {
  inputs: ['flights'],
  title: 'Lignes par compagnie',
  description: 'Vols et retards à l’arrivée par ligne, les deux sens réunis, pour toutes les compagnies et pour chacune.',
  fn: (flights) => {
    const acc = {};
    for (const f of flights) {
      const [a, b] = [f.origin, f.destination].sort();
      for (const k of ['all', f.airline_code]) {
        const r = (acc[k + '|' + a + '|' + b] ??= { airline: k, route: a + ' ↔ ' + b, a, b, flights: 0, distance_km: Number(f.distance_km), operated: 0, late: 0, delaySum: 0 });
        r.flights++;
        if (f.status === 'cancelled') continue;
        r.operated++;
        const d = Number(f.arr_delay_min);
        r.delaySum += d;
        if (d >= 15) r.late++;
      }
    }
    return Object.values(acc).map((r) => ({
      airline: r.airline, route: r.route, a: r.a, b: r.b, flights: r.flights, distance_km: r.distance_km, operated: r.operated,
      pct_late: r.operated ? r.late / r.operated : 0, avg_arr_delay: r.operated ? r.delaySum / r.operated : 0,
    }));
  },
});

dash.calc('hours_by_airline', {
  inputs: ['flights'],
  title: 'Départs et retards par heure',
  description: 'Départs prévus par heure UTC et part de départs en retard, pour toutes les compagnies et pour chacune.',
  fn: (flights) => {
    const acc = {};
    const keys = new Set(['all']);
    const get = (k, h) => (acc[k + '|' + h] ??= { airline: k, hour: h, departures: 0, operated: 0, late: 0, delaySum: 0 });
    for (const f of flights) {
      keys.add(f.airline_code);
      const h = Number(f.scheduled_dep_utc.slice(11, 13));
      for (const k of ['all', f.airline_code]) {
        const r = get(k, h);
        r.departures++;
        if (f.status === 'cancelled') continue;
        r.operated++;
        const d = Number(f.dep_delay_min);
        r.delaySum += d;
        if (d >= 15) r.late++;
      }
    }
    const rows = [];
    for (const k of keys) {
      for (let h = 0; h < 24; h++) {
        const r = get(k, h);
        rows.push({ airline: k, hour: h, departures: r.departures, pct_dep_late: r.operated ? r.late / r.operated : 0, avg_dep_delay: r.operated ? r.delaySum / r.operated : 0 });
      }
    }
    return rows;
  },
});

dash.calc('buckets_by_airline', {
  inputs: ['flights'],
  title: 'Retards à l’arrivée par tranche',
  description: 'Vols opérés classés par tranche de retard à l’arrivée, pour toutes les compagnies et pour chacune.',
  fn: (flights) => {
    const labels = ['À l’heure ou en avance', '1 à 14 min', '15 à 29 min', '30 à 59 min', '1 h à 2 h', '2 h et plus'];
    const upper = [0, 14, 29, 59, 119];
    const counts = {};
    for (const f of flights) {
      if (f.status === 'cancelled') continue;
      const d = Number(f.arr_delay_min);
      const i = upper.findIndex((u) => d <= u);
      for (const k of ['all', f.airline_code]) (counts[k] ??= labels.map(() => 0))[i < 0 ? 5 : i]++;
    }
    const rows = [];
    for (const k of Object.keys(counts)) {
      const total = counts[k].reduce((s, n) => s + n, 0);
      labels.forEach((bucket, i) => rows.push({ airline: k, order: i, bucket, flights: counts[k][i], share: counts[k][i] / total }));
    }
    return rows;
  },
});

dash.calc('airborne', {
  inputs: ['flights'],
  title: 'Vols en l’air toutes les 5 minutes',
  description: 'Nombre de vols entre le décollage et l’atterrissage réels, à chaque pas de 5 minutes UTC de la journée.',
  fn: (flights) => {
    const day0 = Date.parse(flights[0].scheduled_dep_utc.slice(0, 10) + 'T00:00:00Z');
    const STEPS = 288;
    const counts = {};
    const keys = new Set(['all']);
    for (const f of flights) {
      keys.add(f.airline_code);
      if (f.status === 'cancelled') continue;
      const t0 = (Date.parse(f.actual_dep_utc) - day0) / 60000;
      const t1 = (Date.parse(f.actual_arr_utc) - day0) / 60000;
      const s0 = Math.max(0, Math.ceil(t0 / 5));
      const s1 = Math.min(STEPS - 1, Math.ceil(t1 / 5) - 1);
      for (const k of ['all', f.airline_code]) {
        const c = (counts[k] ??= new Array(STEPS).fill(0));
        for (let s = s0; s <= s1; s++) c[s]++;
      }
    }
    const rows = [];
    for (const k of keys) {
      const c = counts[k] || new Array(STEPS).fill(0);
      for (let s = 0; s < STEPS; s++) rows.push({ airline: k, step: s, in_air: c[s] });
    }
    return rows;
  },
});

dash.calc('airlines_ranked', {
  inputs: ['flights'],
  title: 'Compagnies : volumes et retards',
  description: 'Vols, annulations, part d’arrivées en retard et retard moyen par compagnie.',
  fn: (flights) => {
    const m = {};
    for (const f of flights) {
      const a = (m[f.airline_code] ??= { code: f.airline_code, name: f.airline_name, flights: 0, cancelled: 0, operated: 0, late: 0, delaySum: 0 });
      a.flights++;
      if (f.status === 'cancelled') { a.cancelled++; continue; }
      a.operated++;
      const d = Number(f.arr_delay_min);
      a.delaySum += d;
      if (d >= 15) a.late++;
    }
    return Object.values(m)
      .map((a) => ({ code: a.code, name: a.name, flights: a.flights, cancelled: a.cancelled, pct_late: a.late / a.operated, avg_arr_delay: a.delaySum / a.operated }))
      .sort((a, b) => b.flights - a.flights || a.code.localeCompare(b.code));
  },
});
