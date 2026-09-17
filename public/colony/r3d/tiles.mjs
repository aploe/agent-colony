/* Plattformen: eine Wabe = ein Sechskant-Prisma mit Leuchtkante, auf ihrer
 * Familienstufe, plus Stege zum Parent und zwei Hervorhebungsringe (Hover,
 * Auswahl). Plattformen und Kanten sind je EIN InstancedMesh — 30 Felder
 * sollen nicht 60 Meshes sein.
 *
 * Farben wie in 2D: Oberseite = Aktivitaet (COLORS.state, ohne Transkript
 * COLORS.empty), Kante = Git (COLORS.git, zugeklappt aggregiert). Die Kante
 * ist unbeleuchtet (MeshBasicMaterial), damit sie in jeder Lage gleich
 * leuchtet — das ist das Signal, das im Reel auf Distanz uebrig bleibt.
 *
 * Bewusst nicht uebernommen (Plan, Abweichung 7): das Punktraster auf stale,
 * Geister-Umrisse und Familien-Hervorhebung beim Chip-Hover. Die
 * gestrichelte norepo-Kante ist am 2026-09-13 nachgereicht worden — grau
 * allein trug das Signal im Bild nicht. */

import * as THREE from 'three';
import { DIRS, aggregateGit, cellsOf, descendantsOf } from '../hexmap.mjs';
import { COLORS, app } from '../store.mjs';
import * as notch from './notch.mjs';
import * as pave from './pave.mjs';
import * as scene from './scene.mjs';
import * as skin from './skin.mjs';
import { BRIDGE_W, FLOOR_Y, LIFT_MS, TILE_H, TILE_R, cellWorldOf, rimDist, worldOf } from './world.mjs';

const RIM_W = 5;
const STATION_FILL = '#1b2430'; // wie die Hangar-Flaeche in map.mjs
const BRIDGE_H = 2;
const BRIDGE_IN = 14;           // so weit greift ein Steg auf das Kind ueber (clean: auf beide Plattformen)
// Kit: am Parent liegt der Steg in einer U-Bucht (notch.mjs); sein Ende steht
// 1 hinter der Mitte des U-Bogens, damit die Ecken des Tunnels in der Bucht bleiben.
const BRIDGE_IN_NOTCH = notch.NOTCH_DEPTH - notch.NOTCH_W / 2 - 1;
const BRIDGE_COLOR = 0x8fd3ff;  // COLORS.family.bridge ohne Alpha; Deckkraft unten

/* Sechskant-Prisma, Oberkante bei y=0. CylinderGeometry mit sechs Segmenten
 * IST ein Hex-Prisma; thetaStart pi/2 legt die Ecken auf +-x wie hexPath()
 * in 2D (flat-top). Nicht indiziert mit neu gerechneten Normalen: so sind
 * die Seitenflaechen flach schattiert statt mit dem radialen Verlauf, den
 * CylinderGeometry seinen Eckpunkten gibt -- die Deckplatte einer Plattform
 * mit Buchten (notch.mjs, ExtrudeGeometry, flach) sass sonst sichtbar
 * abgesetzt auf dem Block darunter (Andrés Befund, 2026-09-14).
 *
 * Die Instanz streckt sich in y bis zur Bodenplatte (sync()): ein Parent,
 * der je Kinderstufe hochfaehrt, steht so auf einem Block in seiner eigenen
 * Farbe, statt zu schweben oder auf einem Sockel in Bodenfarbe zu sitzen
 * (Andrés Wunsch: "als wuerde die Wabe auf ihrem eigenen Sockel hochfahren"). */
const platformGeo = new THREE.CylinderGeometry(TILE_R, TILE_R, TILE_H, 6, 1, false, Math.PI / 2).translate(0, -TILE_H / 2, 0).toNonIndexed();
platformGeo.computeVertexNormals();
// UVs fuer den Plattenbelag (pave.mjs): dieselbe Rechnung wie fuer die
// Buchtenplatte, damit beide Geometrien denselben Massstab tragen. Im Skin
// clean bleibt die Geometrie dieselbe, das Material dort hat keine Textur.
pave.paveUVs(platformGeo);
/* Die Leuchtkante ist seit 2026-09-14 in sechs Segmente zerlegt, eins je
 * Hexkante: ein Projekt kann mehrere Waben belegen (hexmap.mjs::sizeOf), und
 * dann darf nur die Aussenkante des Klumpens leuchten. Ein voller Ring je
 * Zelle liesse vier Waben wie vier Projekte aussehen.
 *
 * Gebaut wird die Kante k=0 (Ecken bei 0 und 60 Grad, in XZ wie insideHex
 * und hexPath); die Instanz dreht sie um -k*60 Grad um y an ihren Platz. */
function rimSegment(inner, outer, dash = 0, gap = 0) {
  const pos = [];
  const a0 = 0;
  const a1 = Math.PI / 3;
  /* Linear zwischen den beiden Ecken, nicht auf dem Kreisbogen. Ohne
   * Luecken faellt der Unterschied nicht auf, weil nur t=0 und t=1
   * abgetastet werden; mit Luecken lagen alle Zwischenpunkte auf dem
   * Umkreis und woelbten jede Kante nach aussen -- die norepo-Felder sahen
   * rund aus statt sechseckig (Andrés Befund, 2026-09-14). Die Strichkanten
   * liegen jetzt auf denselben zwei Sehnen wie das volle Trapez. */
  const c0 = [Math.cos(a0), Math.sin(a0)];
  const c1 = [Math.cos(a1), Math.sin(a1)];
  const at = (t) => [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t];
  // Ohne Luecken ein Trapez, mit Luecken das Muster der norepo-Kante. Die
  // Zyklenzahl wird auf die Kantenlaenge gerundet (beim regelmaessigen
  // Sechseck ist sie gleich dem Umkreisradius), damit jede Kante mit einem
  // Strich endet und die Ecken gezeichnet sind.
  const cycles = dash ? Math.max(1, Math.round(outer / (dash + gap))) : 1;
  const step = 1 / cycles;
  const on = dash ? step * (dash / (dash + gap)) : step;
  for (let c = 0; c < cycles; c++) {
    const t0 = c * step;
    const t1 = t0 + on;
    const [ux0, uz0] = at(t0);
    const [ux1, uz1] = at(t1);
    const ox0 = ux0 * outer, oz0 = uz0 * outer;
    const ox1 = ux1 * outer, oz1 = uz1 * outer;
    const ix0 = ux0 * inner, iz0 = uz0 * inner;
    const ix1 = ux1 * inner, iz1 = uz1 * inner;
    pos.push(ox0, 0, oz0, ox1, 0, oz1, ix1, 0, iz1);
    pos.push(ox0, 0, oz0, ix1, 0, iz1, ix0, 0, iz0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const rimGeo = rimSegment(TILE_R - RIM_W, TILE_R);
// Bleibt innerhalb der Leuchtkante (rimGeo: TILE_R-5 .. TILE_R): die Kante ist
// das Git-Signal und darf nie ueberdeckt werden; nach aussen ginge der Ring
// in den Rand der Nachbarwabe.
const hiGeo = new THREE.RingGeometry(TILE_R - 12, TILE_R - 5.5, 6).rotateX(-Math.PI / 2);

/* Dieselbe Kante mit Luecken, fuer `norepo`: in 2D zieht map.mjs dort
 * setLineDash([6, 5]). Als Flaeche gebaut, nicht als Linie -- ein
 * LineDashedMaterial traegt keine Instanzfarbe, und eine WebGL-Linie ist nie
 * breiter als 1 px. */
const dashRimGeo = rimSegment(TILE_R - RIM_W, TILE_R, 6, 5);

const bridgeGeo = new THREE.BoxGeometry(BRIDGE_W, BRIDGE_H, 1); // Laenge kommt aus scale.z

const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);
const _sc = new THREE.Vector3();   // (1, y-Streckung, 1) der Plattformen
const _col = new THREE.Color();

let group = null;
let platforms = null; // InstancedMesh; userData.hexes[i] = Feld oder null (Hangar, versteckt)
let rims = null;
let dashRims = null; // dieselben Instanzen, gestrichelte Geometrie: je Feld ist genau eins von beiden sichtbar
let hover = null;
let selected = null;
const bridges = new Map(); // Kind-ID -> Mesh
// Ausfahren: Kind-ID -> Zeitpunkt, an dem der Steg zu wachsen begann. Ein
// Steg, der neu auftaucht (Aufklappen), waechst in LIFT_MS vom Parent zum
// Kind (Andrés Wunsch vom 2026-09-14); beim ersten Frame eines Planeten
// stehen alle sofort, wie die Plattformen bei liftY().
const births = new Map();
let bornPlanet = null;
let bridgeSegs = null;      // Kit-Skin: Steg-Segmente als ein InstancedMesh
const stationParts = [];    // Kit-Skin: Meshes der Station, Reihenfolge = Stapel von unten
const notched = new Map();  // Kit-Skin: Parent-ID -> { key, platform, rim, ring, notches } fuer Plattformen mit Buchten
const _helper = new THREE.Object3D(); // fuer lookAt-Quaternionen der Segmente

function mount(scene) {
  if (group) return;
  group = new THREE.Group();
  group.name = 'tiles';
  hover = new THREE.Mesh(hiGeo, new THREE.MeshBasicMaterial({ color: 0xe6edf3, transparent: true, opacity: 0.35 }));
  selected = new THREE.Mesh(hiGeo, new THREE.MeshBasicMaterial({ color: 0xe6edf3, transparent: true, opacity: 0.6 }));
  hover.visible = false;
  selected.visible = false;
  group.add(hover, selected);
  scene.add(group);
}

/* Kapazitaet nachziehen, wenn ein Planet mehr Felder hat als bisher. */
function ensure(n) {
  if (platforms && platforms.instanceMatrix.count >= n && platforms.material === (skin.role('platformMaterial') ?? platforms.material)) return;
  if (platforms) {
    group.remove(platforms, rims, dashRims);
    platforms.dispose();
    rims.dispose();
    dashRims.dispose();
  }
  const cap = Math.max(16, Math.ceil(n * 1.5));
  const mat = skin.role('platformMaterial') ?? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  platforms = new THREE.InstancedMesh(platformGeo, mat, cap);
  platforms.castShadow = true;
  platforms.receiveShadow = true;
  // Sechs Kantensegmente je Zelle, von denen nur die Aussenkanten eines
  // Klumpens sichtbar geschaltet werden.
  rims = new THREE.InstancedMesh(rimGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), cap * 6);
  dashRims = new THREE.InstancedMesh(dashRimGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), cap * 6);
  // Instanzen wandern (Umordnungsfahrt); die Kugel wuesste es nicht.
  platforms.frustumCulled = false;
  rims.frustumCulled = false;
  dashRims.frustumCulled = false;
  platforms.userData.hexes = [];
  group.add(platforms, rims, dashRims);
}

const _up = new THREE.Vector3(0, 1, 0);
function setInstance(mesh, i, x, y, z, shown, color, sy = 1, rot = 0) {
  _pos.set(x, y, z);
  _quat.setFromAxisAngle(_up, rot);
  _m.compose(_pos, _quat, shown ? _sc.set(1, sy, 1) : _zero); // versteckt = Skalierung 0: nicht zu sehen, nicht zu treffen
  mesh.setMatrixAt(i, _m);
  mesh.setColorAt(i, _col.set(color));
}

function placeRing(ring, h, idx, now) {
  ring.visible = Boolean(h);
  if (!h) return;
  const w = worldOf(h, idx, now);
  ring.position.set(w.x, w.y + 0.6, w.z);
  ring.geometry = notched.get(h.id)?.ring ?? hiGeo; // mit Luecken, wo ein Steg ansetzt
}

/* Plattformen mit Buchten (Kit): eine eigene Deckplatte (NOTCH_FLOOR dick,
 * mit den U-Ausschnitten) je Parent mit sichtbaren Kindern, weil ein
 * InstancedMesh nur eine Geometrie kennt und die Buchten je Parent anders
 * liegen. Der Block darunter bleibt die Instanz, um NOTCH_FLOOR abgesenkt
 * (sync()) -- dasselbe Material, dieselbe Farbe, flache Normalen auf beiden:
 * ein Block. Geometrie neu nur, wenn sich die Stegrichtungen oder die
 * Kantenart (gestrichelt) aendern -- waehrend einer Umordnungsfahrt also je
 * Frame, danach nie. */
function syncNotches(links, idx, now) {
  const byParent = new Map();
  for (const l of links) {
    if (!byParent.has(l.parent.id)) byParent.set(l.parent.id, { h: l.parent, dirs: [] });
    byParent.get(l.parent.id).dirs.push([l.ux, l.uz]);
  }
  for (const id of [...notched.keys()]) if (!byParent.has(id)) dropNotched(id);
  for (const [id, { h, dirs }] of byParent) {
    const git = h.gitState; // ein Parent mit sichtbaren Kindern ist nicht zugeklappt
    const dashed = git === 'norepo';
    const key = dirs.map(([ux, uz]) => Math.round(Math.atan2(uz, ux) * 1000)).sort((a, b) => a - b).join(',') + (dashed ? ':d' : ':s');
    let rec = notched.get(id);
    if (rec && rec.key !== key) {
      dropNotched(id);
      rec = null;
    }
    if (!rec) {
      const notches = dirs.map(([ux, uz]) => notch.notchOf(ux, uz));
      // Material wie skin.role('platformMaterial'), aber mit eigener Farbe: ein
      // Einzelmesh hat keine Instanzfarbe.
      const platform = new THREE.Mesh(pave.paveUVs(notch.topGeometry(notches)), pave.apply(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 })));
      platform.castShadow = true;
      platform.receiveShadow = true;
      const rim = new THREE.Mesh(notch.rimGeometry(notches, dashed, RIM_W), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
      group.add(platform, rim);
      rec = { key, platform, rim, ring: notch.ringGeometry(notches), notches };
      notched.set(id, rec);
    }
    rec.platform.userData.hex = h; // jeder Poll bringt frische Objekte
    const w = worldOf(h, idx, now);
    rec.platform.position.set(w.x, w.y, w.z);
    rec.rim.position.set(w.x, w.y + 0.3, w.z);
    rec.platform.material.color.set(COLORS.state[h.state] ?? COLORS.empty);
    rec.rim.material.color.set(COLORS.git[git] ?? '#6f7785');
  }
}

function dropNotched(id) {
  const r = notched.get(id);
  if (!r) return;
  group.remove(r.platform, r.rim);
  r.platform.geometry.dispose();
  r.platform.material.dispose();
  r.rim.geometry.dispose();
  r.rim.material.dispose();
  r.ring.dispose();
  notched.delete(id);
}

function sync(p, idx, now) {
  scene.syncEnv(p, idx, now);
  /* Ein Slot je Wabe, nicht je Projekt: ein Projekt belegt sizeOf(h) Zellen
   * (hexmap.mjs), der Hangar genau eine. `first` ist die Hauptzelle -- dort
   * sitzen Label, Skyline, Figuren und die Steg-Buchten, die Zusatzwaben
   * sind nur Flaeche. */
  const slots = [{ h: p.station, cell: { q: p.station.q, r: p.station.r }, station: true, first: true, mine: null }];
  for (const h of p.hexes) {
    const cells = cellsOf(h);
    const mine = new Set(cells.map((c) => c.q + ',' + c.r));
    cells.forEach((cell, n) => slots.push({ h, cell, station: false, first: n === 0, mine }));
  }
  ensure(slots.length);
  platforms.count = slots.length;
  rims.count = slots.length * 6;
  dashRims.count = slots.length * 6;
  const hexes = platforms.userData.hexes;
  hexes.length = 0;

  // Stege: Kit reiht Tunnel-Segmente aneinander, clean nimmt weiter je ein
  // Kasten je sichtbarem Kind mit sichtbarem Parent, knapp unter der
  // Oberkante. Seit 2026-09-14 Kante zu Kante statt Mitte zu Mitte: der Steg
  // endet BRIDGE_IN innerhalb der Kind-Kante -- er greift auf das Kind ueber,
  // statt als Rohr durch den hoeheren Parent zu laufen (Andrés Befund im
  // Browser). Am Parent: clean ebenso BRIDGE_IN unter der Oberkante; Kit
  // dagegen in einer U-Bucht (notch.mjs), BRIDGE_IN_NOTCH hinter der Kante
  // und NOTCH_FLOOR unter der Oberkante, damit der Tunnel in der Plattform
  // liegt statt auf ihr. Zwischen zwei Stufen wird er zur Rampe. Vor der
  // Instanzschleife gerechnet, weil sie wissen muss, welche Parents eine
  // Bucht bekommen (deren Instanz bleibt auf Skalierung 0).
  const seg = skin.role('bridge');
  const links = [];
  for (const h of p.hexes) {
    if (h.hidden || !h.parentId) continue;
    const par = idx.byId.get(h.parentId);
    if (!par || par.hidden) continue;
    const a = worldOf(par, idx, now);
    const c = worldOf(h, idx, now);
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) continue;
    const ux = dx / dist;
    const uz = dz / dist;
    const rim = rimDist(Math.atan2(uz, ux)); // Sechseck ist punktsymmetrisch: gilt fuer beide Enden
    const rKid = rim - BRIDGE_IN;
    const rPar = seg ? rim - BRIDGE_IN_NOTCH : rKid;
    if (rPar + rKid >= dist) continue; // Plattformen wuerden sich ueberlappen -- kommt im Layout nicht vor
    const yPar = seg ? a.y - notch.NOTCH_FLOOR : a.y - 1;
    links.push({ id: h.id, parent: par, ux, uz, from: new THREE.Vector3(a.x + ux * rPar, yPar, a.z + uz * rPar), to: new THREE.Vector3(c.x - ux * rKid, c.y - 1, c.z - uz * rKid) });
  }
  syncNotches(seg ? links : [], idx, now);

  slots.forEach((slot, i) => {
    const { h, cell, station: isStation, first, mine } = slot;
    const shown = isStation || !h.hidden;
    // Plattform mit Buchten: die Deckplatte der Hauptzelle ist ein eigenes
    // Mesh (notch.mjs), die Zusatzwaben bleiben gewoehnliche Prismen.
    const cut = !isStation && first && notched.has(h.id);
    const w = isStation ? worldOf(h, idx, now) : cellWorldOf(h, cell, idx, now);
    hexes[i] = isStation || h.hidden ? null : h;
    // `state: null` = kein Transkript: neutrale Flaeche statt geratener Farbe (wie map.mjs)
    const fill = isStation ? STATION_FILL : (COLORS.state[h.state] ?? COLORS.empty);
    // Die Instanz reicht von ihrer Oberkante bis zur Bodenplatte (ein Block in
    // Wabenfarbe, auf Stufe 0 nur den halben Spalt tiefer, unsichtbar). Mit
    // Buchten liegt ihre Oberkante NOTCH_FLOOR tiefer: sie ist dann der Block
    // unter der Deckplatte und zugleich der Boden jeder Bucht.
    const top = cut ? w.y - notch.NOTCH_FLOOR : w.y;
    setInstance(platforms, i, w.x, top, w.z, shown, fill, (top - FLOOR_Y) / TILE_H);
    // Zugeklappt traegt der Container den Git-Zustand seiner Kinder — sonst
    // versteckte das Zuklappen genau den Zustand, wegen dem es Satelliten gibt.
    const kids = !isStation && h.satellites ? descendantsOf(h.id, idx) : [];
    const git = isStation ? null : app.collapsed.has(h.id) ? aggregateGit(h, kids) : h.gitState;
    // Der Hangar hat keine Leuchtkante: er ist kein Projekt.
    // Kein Repo -> gestrichelt, wie in 2D. Beide Meshes bekommen Position und
    // Farbe, sichtbar ist immer genau eins (das andere auf Skalierung 0) —
    // so bleibt der Instanzindex in beiden derselbe wie bei den Plattformen.
    const rimShown = shown && !isStation && !cut;
    const rimColor = COLORS.git[git] ?? '#6f7785';
    for (let k = 0; k < 6; k++) {
      // Kante k ist die Aussenkante Richtung DIRS[(6 - k) % 6]; liegt dort
      // eine eigene Wabe, bleibt sie dunkel -- ein Klumpen hat einen Rand,
      // nicht vier.
      const d = DIRS[(6 - k) % 6];
      const outer = !mine || !mine.has(cell.q + d[0] + ',' + (cell.r + d[1]));
      const j = i * 6 + k;
      setInstance(rims, j, w.x, w.y + 0.3, w.z, rimShown && outer && git !== 'norepo', rimColor, 1, (-k * Math.PI) / 3);
      setInstance(dashRims, j, w.x, w.y + 0.3, w.z, rimShown && outer && git === 'norepo', rimColor, 1, (-k * Math.PI) / 3);
    }
  });
  platforms.instanceMatrix.needsUpdate = true;
  rims.instanceMatrix.needsUpdate = true;
  dashRims.instanceMatrix.needsUpdate = true;
  platforms.instanceColor.needsUpdate = true;
  rims.instanceColor.needsUpdate = true;
  dashRims.instanceColor.needsUpdate = true;
  platforms.computeBoundingSphere(); // der Raycaster (pick.mjs) prueft erst die Kugel

  placeRing(hover, app.hover && !app.hover.hidden ? app.hover : null, idx, now);
  placeRing(selected, app.selected && !app.selected.hidden ? app.selected : null, idx, now);

  // Ausfahren: `to` rueckt fuer die Dauer der Fahrt vom Parent-Ende zum
  // Kind-Ende vor (Ease-out wie liftY); `full` bleibt die ganze Laenge, damit
  // die Segmentzahl im Kit waehrend der Fahrt nicht springt -- die Segmente
  // stauchen sich und strecken sich, wie ein Teleskop.
  const fresh = bornPlanet !== p.id;
  bornPlanet = p.id;
  const seenIds = new Set();
  for (const l of links) {
    seenIds.add(l.id);
    if (!births.has(l.id)) births.set(l.id, fresh ? -Infinity : now);
    const t = Math.min(1, Math.max(0, (now - births.get(l.id)) / LIFT_MS));
    l.full = l.from.distanceTo(l.to);
    l.dir = new THREE.Vector3().subVectors(l.to, l.from).normalize();
    l.to = l.from.clone().addScaledVector(l.dir, l.full * (1 - (1 - t) ** 3));
  }
  for (const id of births.keys()) if (!seenIds.has(id)) births.delete(id);

  if (seg) {
    // Kit: Segmente wiederholt entlang der Laenge, leicht gestreckt statt
    // Luecke — die Zahl rundet, der Rest verteilt sich als milde Streckung
    // (scale.z = pitch / seg.length) gleichmaessig auf alle Segmente.
    let total = 0;
    for (const l of links) total += Math.max(1, Math.round(l.full / seg.length));
    if (!bridgeSegs || bridgeSegs.instanceMatrix.count < total) {
      if (bridgeSegs) {
        group.remove(bridgeSegs);
        bridgeSegs.dispose();
      }
      bridgeSegs = new THREE.InstancedMesh(seg.geometry, seg.material, Math.max(16, Math.ceil(total * 1.5)));
      bridgeSegs.frustumCulled = false;
      bridgeSegs.castShadow = true;
      bridgeSegs.receiveShadow = true;
      group.add(bridgeSegs);
    }
    let si = 0;
    for (const l of links) {
      const dist = l.from.distanceTo(l.to); // waehrend des Ausfahrens kuerzer als l.full
      const n = Math.max(1, Math.round(l.full / seg.length));
      const pitch = dist / n;
      _helper.position.copy(l.from);
      _helper.lookAt(l.from.clone().add(l.dir)); // +z des Segments zeigt zum Kind, wie der Kasten in clean
      for (let k = 0; k < n; k++, si++) {
        _pos.copy(l.from).addScaledVector(l.dir, (k + 0.5) * pitch);
        bridgeSegs.setMatrixAt(si, _m.compose(_pos, _helper.quaternion, new THREE.Vector3(1, 1, pitch / seg.length)));
      }
    }
    bridgeSegs.count = si;
    bridgeSegs.instanceMatrix.needsUpdate = true;
    for (const b of bridges.values()) b.visible = false;
  } else {
    // Clean: ein Kasten je Steg, Pool nach Kind-ID
    const seen = new Set();
    for (const l of links) {
      let b = bridges.get(l.id);
      if (!b) {
        b = new THREE.Mesh(bridgeGeo, new THREE.MeshBasicMaterial({ color: BRIDGE_COLOR, transparent: true, opacity: 0.75 }));
        bridges.set(l.id, b);
        group.add(b);
      }
      b.position.lerpVectors(l.from, l.to, 0.5);
      b.lookAt(l.from.clone().add(l.dir));
      b.scale.z = l.from.distanceTo(l.to);
      b.visible = true;
      seen.add(l.id);
    }
    for (const [id, b] of bridges) {
      if (seen.has(id)) continue;
      group.remove(b);
      b.material.dispose();
      bridges.delete(id);
    }
    if (bridgeSegs) bridgeSegs.count = 0;
  }

  // Station: Kit stapelt lander_base und lander_A auf die Hangar-Plattform;
  // stumm, nie eine Signalfarbe, nicht in hitObjects().
  const parts = skin.role('station');
  if (parts && !stationParts.length) {
    for (const pt of parts) {
      const m = new THREE.Mesh(pt.geometry, pt.material);
      m.castShadow = true;
      m.receiveShadow = true;
      stationParts.push({ mesh: m, height: pt.size[1] });
      group.add(m);
    }
  }
  if (stationParts.length) {
    const w = worldOf(p.station, idx, now);
    let y = w.y;
    for (const pt of stationParts) {
      pt.mesh.visible = Boolean(parts);
      pt.mesh.position.set(w.x, y, w.z);
      y += pt.height;
    }
  }
}

/* Skin-Wechsel: Plattformen (Material), Steg-Segmente, Buchten und Station verwerfen;
 * Kanten und Ringe sind skin-unabhaengig und bleiben. Kit-Geometrien und
 * -Materialien gehoeren kit.mjs, kein dispose() darauf. */
function rebuild() {
  if (platforms) {
    group.remove(platforms, rims, dashRims);
    platforms.dispose();
    rims.dispose();
    dashRims.dispose();
    platforms = null;
    rims = null;
    dashRims = null;
  }
  if (bridgeSegs) {
    group.remove(bridgeSegs);
    bridgeSegs.dispose();
    bridgeSegs = null;
  }
  for (const pt of stationParts) group.remove(pt.mesh);
  stationParts.length = 0;
  for (const id of [...notched.keys()]) dropNotched(id);
}

function unmount() {}

const hitObjects = () => (platforms ? [platforms, ...[...notched.values()].map((r) => r.platform)] : []);
/* Buchten eines Felds (Kit, nur Parents mit sichtbaren Kindern), plattform-lokal;
 * builds.mjs laesst Gelaende dort weg. Gueltig nach sync() desselben Frames. */
const notchesOf = (hexId) => notched.get(hexId)?.notches ?? [];
const bridgeCount = () => [...bridges.values()].filter((b) => b.visible).length;
/* Faehrt noch ein Steg aus? index.mjs haelt dann die Frames am Laufen, wie bei lifting(). */
const animating = (now) => [...births.values()].some((t0) => now - t0 < LIFT_MS);

export { BRIDGE_IN, BRIDGE_IN_NOTCH, animating, bridgeCount, hitObjects, mount, notchesOf, rebuild, sync, unmount };
