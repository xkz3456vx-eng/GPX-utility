import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, simplify, PolylineIndex, encodePolyline, decodePolyline, chunkByDistance } from '../js/core/geo.js';
import { parseWayTags, classifySurface, classifyWayType, computeClimb, analyzeRoute, SURFACE, WAY } from '../js/analysis/route-analysis.js';
import { parseGeoJson, profileParams, explainError } from '../js/services/brouter.js';
import { HttpError } from '../js/core/http.js';
import { exportGpx, xmlEscape, safeFilename } from '../js/io/gpx.js';
import { findGaps } from '../js/analysis/alerts.js';
import { buildQuery, toPoi } from '../js/services/overpass.js';
import { toSharePayload, fromSharePayload } from '../js/io/storage.js';
import { newDoc } from '../js/core/store.js';
import { PROFILES } from '../js/config.js';

const line = (n, lat0 = 45, lng0 = 5, step = 0.001) => Array.from({ length: n }, (_, i) => ({ lat: lat0, lng: lng0 + i * step, ele: 100 + i }));

test('haversine : 1° de latitude ≈ 111 km', () => {
  assert.ok(Math.abs(haversine(45, 5, 46, 5) - 111195) < 50);
});

test('simplify conserve les extrémités et élimine les points alignés', () => {
  const s = simplify(line(50), 1);
  assert.equal(s.length, 2);
});

test('PolylineIndex trouve la distance au tracé et la position le long', () => {
  const pts = line(101); // ~7,9 km vers l'est
  const idx = new PolylineIndex(pts);
  const n = idx.nearest(45.005, 5.05, 2000); // ~555 m au nord du milieu
  assert.ok(Math.abs(n.dist - 556) < 5, `dist ${n.dist}`);
  assert.ok(Math.abs(n.along - idx.cum[50]) < 5);
  assert.equal(idx.nearest(45.1, 5.05, 2000), null);
});

test('polyline encode/decode aller-retour', () => {
  const pts = [{ lat: 45.12345, lng: 5.54321 }, { lat: -12.5, lng: 170.00001 }];
  const back = decodePolyline(encodePolyline(pts));
  back.forEach((p, i) => { assert.ok(Math.abs(p.lat - pts[i].lat) < 1e-5); assert.ok(Math.abs(p.lng - pts[i].lng) < 1e-5); });
});

test('chunkByDistance découpe avec points de jonction partagés', () => {
  const chunks = chunkByDistance(line(101), 2000);
  assert.ok(chunks.length >= 3);
  for (let i = 1; i < chunks.length; i++) assert.deepEqual(chunks[i][0], chunks[i - 1].at(-1));
});

test('classification des surfaces et types de voie', () => {
  const c = (s) => classifySurface(parseWayTags(s));
  assert.equal(c('highway=secondary'), SURFACE.asphalt);
  assert.equal(c('highway=track tracktype=grade2'), SURFACE.gravel);
  assert.equal(c('highway=track surface=dirt'), SURFACE.dirt);
  assert.equal(c('highway=path surface=ground'), SURFACE.path);
  assert.equal(c('highway=path'), SURFACE.path);
  assert.equal(c('highway=residential surface=compacted'), SURFACE.gravel);
  assert.equal(classifyWayType(parseWayTags('highway=cycleway')), WAY.cycleway);
  assert.equal(classifyWayType(parseWayTags('highway=primary')), WAY.major);
  assert.equal(classifyWayType(parseWayTags('highway=track bicycle=designated')), WAY.cycleway);
});

test('dénivelé avec hystérésis', () => {
  assert.deepEqual(computeClimb([100, 101, 100, 110, 105, 120, 90]), { up: 25, down: 35 });
});

test('parseGeoJson associe les tags BRouter aux points', () => {
  const coords = [[5, 45, 100], [5.001, 45, 101], [5.002, 45, 102], [5.003, 45, 103]];
  const head = ['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags', 'NodeTags', 'Time', 'Energy'];
  const json = { features: [{ geometry: { type: 'LineString', coordinates: coords }, properties: { messages: [head,
    ['5001000', '45000000', '101', '80', '', '', '', '', '', 'highway=residential', '', '', ''],
    ['5003000', '45000000', '103', '160', '', '', '', '', '', 'highway=track tracktype=grade3', '', '', '']] } }] };
  const r = parseGeoJson(json);
  assert.deepEqual(r.tagList, ['highway=residential', 'highway=track tracktype=grade3']);
  assert.deepEqual(r.tags, [0, 0, 1, 1]);
});

test('analyzeRoute : distance, dénivelé, répartition, temps', () => {
  const pts = line(101).map((p, i) => ({ ...p, tag: i < 50 ? 0 : 1, leg: 0 }));
  const an = analyzeRoute(pts, ['highway=residential', 'highway=track surface=gravel'], PROFILES.trekking);
  assert.ok(Math.abs(an.totals.distance - 7863) < 20);
  assert.ok(Math.abs(an.totals.ascent - 99) <= 3);
  const sum = an.breakdown.surface.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - an.totals.distance) < 1);
  assert.ok(an.breakdown.surface[SURFACE.gravel] > 3000);
  assert.ok(an.totals.time > 0.3 && an.totals.time < 1);
});

test('paramètres de profil et erreurs BRouter', () => {
  const doc = newDoc();
  doc.prefs.traffic = 1;
  doc.prefs.maxAscent = 1000;
  const p = profileParams(doc);
  assert.equal(p.avoid_unsafe, 1);
  assert.equal(p.consider_elevation, 1);
  assert.equal(explainError(new HttpError('x', { status: 400, body: 'from-position not mapped in existing datafile' })).code, 'offroad');
  assert.equal(explainError(new HttpError('x', { kind: 'network' })).code, 'unavailable');
});

test('export GPX : échappement et structure', () => {
  const xml = exportGpx({ name: 'Test <&>', track: line(3), waypoints: [line(1)[0]], pois: [{ lat: 45, lng: 5, cat: 'water', kind: 'drinking_water', name: 'Fontaine "A"', tags: {} }] });
  assert.match(xml, /<name>Test &lt;&amp;&gt;<\/name>/);
  assert.equal((xml.match(/<trkpt/g) || []).length, 3);
  assert.equal((xml.match(/<wpt/g) || []).length, 2);
  assert.match(xml, /<sym>Drinking Water<\/sym>/);
  assert.equal(xmlEscape(`'"`), '&apos;&quot;');
  assert.equal(safeFilename('Tour du Vercors – été'), 'Tour_du_Vercors_ete');
});

test('findGaps détecte les longues portions sans point d’eau', () => {
  const g = findGaps([10000, 20000, 75000], 100000, 40000);
  assert.deepEqual(g, [{ from: 20000, to: 75000, length: 55000 }]);
});

test('requête Overpass et normalisation des POI', () => {
  const q = buildQuery([{ lat: 45, lng: 5 }, { lat: 45.1, lng: 5.1 }], 500, ['water', 'food']);
  assert.match(q, /around:500,45,5,45\.1,5\.1/);
  assert.match(q, /drinking_water/);
  assert.doesNotMatch(q, /tourism/);
  const poi = toPoi({ type: 'way', id: 3, center: { lat: 45, lon: 5 }, tags: { tourism: 'camp_site', name: 'Camping' } });
  assert.equal(poi.cat, 'lodging');
  assert.equal(poi.id, 'way/3');
  assert.equal(toPoi({ type: 'node', id: 1, lat: 1, lon: 1, tags: { shop: 'shoes' } }), null);
});

test('lien de partage : aller-retour du document', () => {
  const doc = newDoc();
  doc.name = 'Boucle';
  doc.mode = 'loop';
  doc.waypoints = [{ id: 'a', lat: 45.1, lng: 5.1, name: 'Départ' }, { id: 'b', lat: 45.2, lng: 5.2, name: '', straight: true }];
  doc.fixedLegs = { a: { to: 'b', coords: [{ lat: 45.1, lng: 5.1 }, { lat: 45.15, lng: 5.12 }, { lat: 45.2, lng: 5.2 }] } };
  const back = fromSharePayload(JSON.parse(JSON.stringify(toSharePayload(doc))));
  assert.equal(back.name, 'Boucle');
  assert.equal(back.mode, 'loop');
  assert.equal(back.waypoints.length, 2);
  assert.equal(back.waypoints[1].straight, true);
  const fixed = back.fixedLegs[back.waypoints[0].id];
  assert.equal(fixed.to, back.waypoints[1].id);
  assert.equal(fixed.coords.length, 3);
});
