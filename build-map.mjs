import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import fs from 'fs';

const topo = JSON.parse(fs.readFileSync('node_modules/world-atlas/land-110m.json', 'utf8'));
const fc = feature(topo, topo.objects.land);
const geoms = fc.type === 'FeatureCollection' ? fc.features.map((f) => f.geometry) : [fc.geometry];
const polys = geoms.flatMap((g) => (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]));
// on retire l'Antarctique (hors cadre de la carte)
const kept = polys.filter((p) => Math.max(...p[0].map((c) => c[1])) > -60);
const land = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: kept } };

const proj = geoNaturalEarth1().fitWidth(960, { type: 'Sphere' });
const k = proj.scale(), [tx, ty] = proj.translate();
const y0 = Math.floor(proj([0, 84])[1] - 4);
const y1 = Math.ceil(proj([0, -57])[1] + 4);
const d = geoPath(proj).digits(1)(land);

// formule Natural Earth 1 utilisée par la page : doit coïncider avec d3-geo
const raw = (lon, lat) => {
  const l = (lon * Math.PI) / 180, p = (lat * Math.PI) / 180, p2 = p * p, p4 = p2 * p2;
  return [
    tx + k * l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    ty - k * p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
};
let maxErr = 0;
for (const [lon, lat] of [[2.5, 49], [-74, 40.6], [139.7, 35.5], [151.2, -33.9], [-118.4, 33.9], [28.2, -26.1], [-46.4, -23.4], [179, 60], [-179, -50]]) {
  const a = proj([lon, lat]), b = raw(lon, lat);
  maxErr = Math.max(maxErr, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}
console.log({ k, tx, ty, y0, y1, h: y1 - y0, pathBytes: d.length, maxErr });
if (maxErr > 1e-6) throw new Error('la formule ne coïncide pas avec d3-geo');

const out = `// Fond de carte (terres, projection Natural Earth 1) généré par tools/build-map.mjs
// à partir de world-atlas land-110m. Coordonnées en unités du viewBox (largeur 960).
window.MAPDATA = ${JSON.stringify({ w: 960, y0, h: y1 - y0, k: +k.toFixed(6), tx: +tx.toFixed(6), ty: +ty.toFixed(6), land: d })};
`;
fs.writeFileSync('/home/claude/flight-dashboard/dashboard/mapdata.js', out);
fs.mkdirSync('/home/claude/flight-dashboard/tools', { recursive: true });
fs.copyFileSync('build-map.mjs', '/home/claude/flight-dashboard/tools/build-map.mjs');
