// Test de fumée du dashboard : charge index.html dans jsdom avec un faux objet `dash` alimenté par les
// vrais calculs, change les filtres et vérifie que rien ne plante et que les zones se remplissent.
// Usage : NODE_PATH=<dossier avec jsdom et d3> node tests/smoke_page.js data/flights_demo_2026-10-13.csv
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const csvPath = process.argv[2];
const parseCsv = (text) => {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
};
const flights = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const airports = parseCsv(fs.readFileSync(path.join(path.dirname(csvPath), 'airports.csv'), 'utf8'));
const dashDir = path.join(__dirname, '..', 'dashboard');

const calcs = {};
vm.runInNewContext(fs.readFileSync(path.join(dashDir, 'calcs.js'), 'utf8'), { dash: { calc: (id, o) => { calcs[id] = o; } } });
const results = { flights, airports };
for (const [id, c] of Object.entries(calcs)) results[id] = c.fn(...c.inputs.map((i) => results[i]));

const html = fs.readFileSync(path.join(dashDir, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
const dom = new JSDOM(`<div id="dash-root">${html}</div>`, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));

window.SVGElement.prototype.getComputedTextLength = function () { return (this.textContent || '').length * 6; };
window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fill() {}, set globalAlpha(v) {}, set fillStyle(v) {} });
window.Path2D = class { moveTo() {} arc() {} };
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 1000; } });
window.matchMedia = () => ({ matches: true });

const params = { airline: 'all', airport: null, metric: 'volume' };
let cb = null;
const rerun = () => { cb(); };
window.dash = {
  colors: ['#2a78d6', '#eb6834', '#1baf7a'],
  params: () => ({ ...params }),
  setParams: (o) => { Object.assign(params, o); rerun(); },
  onData: (fn) => { cb = fn; },
  data: (id) => ({ status: 'ok', data: results[id] }),
  calc: () => {},
};
const d3Path = (process.env.NODE_PATH || '').split(path.delimiter).map((d) => path.join(d, 'd3', 'dist', 'd3.min.js')).find(fs.existsSync);
window.eval(fs.readFileSync(d3Path, 'utf8'));
for (const f of ['mapdata.js', 'app.js']) window.eval(fs.readFileSync(path.join(dashDir, f), 'utf8'));

let bad = 0;
const check = (label, cond) => { if (!cond) { bad++; console.log('ÉCHEC', label); } };
const doc = window.document;
const q = (s) => doc.querySelector(s);
const state = (label) => {
  check(`${label}: phrase`, q('#take').textContent.length > 60);
  check(`${label}: carte`, q('#c-map svg') && q('#c-map svg').querySelectorAll('.fl-ap').length > 0);
  check(`${label}: graphiques`, ['c-airports', 'c-airlines', 'c-routes', 'c-hours', 'c-buckets', 'c-latehours', 'c-lateairports', 'c-laterroutes'].every((id) => q('#' + id + ' svg') || q('#' + id + ' .fl-empty')));
  check(`${label}: tableau`, doc.querySelectorAll('#c-table tbody tr').length === 22);
  check(`${label}: compteur en l'air`, /\d/.test(q('#t-air').textContent));
};

cb();
state('toutes');
console.log('Phrase :', q('#take').textContent.replace(/\s+/g, ' '));
window.dash.setParams({ airline: 'NVA' }); state('NVA');
console.log('Phrase NVA :', q('#take').textContent.replace(/\s+/g, ' '));
window.dash.setParams({ airport: 'CDG' }); state('NVA+CDG');
check('fiche aéroport visible', !q('#airport-panel').hidden && q('#p-body').querySelectorAll('.row').length > 0);
console.log('Fiche :', q('#p-title').textContent, '| mouvements', q('#p-mov').textContent, '| en l’air', q('#t-air').textContent);
window.dash.setParams({ airline: 'NVA', airport: 'SYD' }); state('NVA+SYD');
check('aéroport non desservi', !q('#p-empty').hidden);
window.dash.setParams({ metric: 'late', airline: 'all', airport: null }); state('retards');
check('fiche masquée', q('#airport-panel').hidden);
check('arcs tracés', q('#c-map svg .fl-arc') !== null);
const rg = q('#t-range'); rg.value = '780'; rg.dispatchEvent(new window.Event('input'));
check('horloge', q('#t-clock').textContent.startsWith('13:00'));
check('aucune erreur de script', errors.length === 0);
if (errors.length) console.log(errors.slice(0, 5));
console.log(bad ? `${bad} échec(s)` : 'OK : la page se dessine pour tous les filtres testés');
process.exit(bad ? 1 : 0);
