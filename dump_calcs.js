// Exécute dashboard/calcs.js sur le CSV et écrit le résultat de chaque calcul en JSON.
// Usage : node tests/dump_calcs.js data/flights_demo_2026-10-13.csv out.json
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const [csvPath, outPath] = process.argv.slice(2);
const parseCsv = (text) => {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
};
const flights = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const airports = parseCsv(fs.readFileSync(path.join(path.dirname(csvPath), 'airports.csv'), 'utf8'));

const calcs = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'calcs.js'), 'utf8'), {
  dash: { calc: (id, o) => { calcs[id] = o; } },
});
const out = {};
for (const [id, c] of Object.entries(calcs)) out[id] = c.fn(...c.inputs.map((i) => (i === 'flights' ? flights : airports)));
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(Object.entries(out).map(([k, v]) => `${k}: ${v.length} lignes`).join('\n'));
