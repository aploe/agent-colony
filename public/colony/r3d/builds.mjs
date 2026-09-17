/* Gebaeude statt Balken: ein Kasten je Kalendertag im Nordband der
 * Plattform, Hoehe = Commits (Bezug app.dayMax wie die 2D-Skyline), plus
 * stummes Gelaende. Positionen kommen aus skyline.mjs, damit 2D und 3D
 * dieselbe Zeitachse zeigen; nur die Hoehe ist 3D-eigen (BUILD_H statt
 * DAY_H: 14 Einheiten waeren auf einer 80er-Plattform nicht zu sehen).
 *
 * Zwei Klassen, sichtbar getrennt (Spec, Entscheidung 2): die Tagesbauten
 * sind Signal (hell, Hover weiss), die Kisten sind Gelaende — grau, nie
 * eine Farbe aus COLORS, nie animiert, nicht in hitObjects(). */

import * as THREE from 'three';
import { DAY_BASE, DAY_PITCH, DAY_W, DAY_X0 } from '../skyline.mjs';
import { cellsOf } from '../hexmap.mjs';
import { HEX, app } from '../store.mjs';
import { inNotch } from './notch.mjs';
import * as skin from './skin.mjs';
import * as tiles from './tiles.mjs';
import { APOTHEM, cellWorldOf, rimDist, worldOf } from './world.mjs';

const DAY_N = 14;
const BUILD_H = 24;
const LIT = '#c9d1d9';     // Tag mit Commits
const DIM = '#3a4350';     // leerer Tag: 1 Einheit Sockel, damit die Achse lesbar bleibt (wie 2D)
const HOT = '#ffffff';     // Tag unter dem Cursor
const TERRAIN = 0x3a4350;  // Gelaende: grau, fest im Material, keine Instanzfarbe
const TERRAIN_PER_TILE = 6;
const TERRAIN_MAX_HALF = 22; // groesstes Platzmass, das ein Slot vergeben kann

// Fuss bei y=0, waechst nach oben: so ist scale.y direkt die Hoehe
const boxGeo = new THREE.BoxGeometry(DAY_W, 1, DAY_W).translate(0, 0.5, 0);
const crateGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

/* Dieselbe Regel wie dayHeight() in skyline.mjs: 2 Minimum fuer einen
 * einzelnen Commit neben einem 46er-Tag, 1 als Sockel fuer leere Tage. */
function buildHeight(n) {
  return n ? Math.max(2, Math.round((BUILD_H * n) / app.dayMax)) : 1;
}

/* Deterministische Streuung aus der Feld-ID: dasselbe Stueck steht bei jedem
 * Poll an derselben Stelle. */
function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/* Die Platzordnung einer Wabe. Seit 2026-09-14 sechs Plaetze statt drei, mit
 * grossen Bauten statt Kisten (Andrés Wunsch: die Felder wirken zu leer,
 * etwa 65 Prozent der Dichte aus dem Reel, dabei lieber wenige grosse
 * Stuecke als viel Kleinkram).
 *
 * Drei Zonen sind vergeben und bleiben frei:
 *  - das Skyline-Band im Norden (z = DAY_BASE = -0,55 HEX, x +-41),
 *  - AGENT_ZONE (agents.mjs): Label, Heimplaetze der Figuren und ihre
 *    Kinderreihen. In der ersten Fassung lagen vier Plaetze darin, Module
 *    standen dort, wo Agenten auftauchen (Andrés Befund),
 *  - die Steg-Buchten am Rand (notch.mjs), je nach Kindern.
 * Uebrig bleiben die beiden waagerechten Ecken (Ost, West -- dort ist der
 * Abstand zur Kante am groessten, TILE_R statt Apothem), die beiden
 * suedlichen Ecken jenseits der Agentenzone und zwei schmalere Plaetze im
 * Norden, seitlich am Band vorbei.
 *
 * `half` ist das halbe Platzmass: builds.mjs deckelt daran die Skalierung,
 * motion.mjs nimmt es als Radius des Hindernisses. */
const SLOTS = [
  { ang: -150, half: 15 }, // Nordwest, westlich am Skyline-Band vorbei
  { ang: -30,  half: 15 }, // Nordost
  { ang: 180,  half: 18 }, // Westecke
  { ang: 0,    half: 18 }, // Ostecke
  { ang: 120,  half: 16 }, // Suedwest, suedlich an der Agentenzone vorbei
  { ang: 60,   half: 16 }, // Suedost
];
const SLOT_GAP = 6; // Abstand des Platzrands zur Plattformkante

/* Zusatzwaben eines Projekts (hexmap.mjs::sizeOf) tragen weder Label noch
 * Figuren noch Skyline -- dort ist die ganze Flaeche Bauland. Sechs Plaetze
 * auf den Ecken und einer in der Mitte; das ist dichter als auf der
 * Hauptwabe und genau der Grund, warum ein grosses Projekt groesser aussehen
 * soll. */
const EXTRA_SLOTS = [
  { ang: 0, half: 17 }, { ang: 60, half: 17 }, { ang: 120, half: 17 },
  { ang: 180, half: 17 }, { ang: 240, half: 17 }, { ang: 300, half: 17 },
  { ang: null, half: 20 }, // Mitte
];

/* Plaetze einer Wabe: die Hauptwabe (cell 0) nimmt SLOTS, jede Zusatzwabe
 * EXTRA_SLOTS mit eigenem Hash -- sonst stuende auf allen Waben eines
 * Projekts dasselbe. */
function terrainSlots(h, cell = 0) {
  const k = hash(cell ? h.id + ':' + cell : h.id);
  return (cell ? EXTRA_SLOTS : SLOTS).map((s, i) => {
    // >>> statt >>: hash() liefert einen vollen 32-Bit-Wert. Mit gesetztem
    // Bit 31 zieht ein vorzeichenbehafteter Shift Einsen nach, das Ergebnis
    // wird negativ, und "% n" behaelt in JS das Vorzeichen des Dividenden --
    // an echten Pfaden beobachtet (2026-09-14, Platz ausserhalb der Wabe).
    const r32 = (k >>> (i * 5)) & 0x1f;
    const half = s.half * (0.82 + (r32 / 31) * 0.18); // milde Streuung, nie groesser als der Platz
    if (s.ang === null) return { x: 0, z: 0, half, rot: ((k >>> (i * 3 + 11)) % 12) * (Math.PI / 6) };
    const ang = (s.ang * Math.PI) / 180;
    /* Das Stueck muss ganz auf der Plattform stehen, nicht nur sein
     * Mittelpunkt: `rimDist(ang) - half` waere nur in Strahlrichtung richtig
     * und liess an den Ecken -- wo zwei Kanten zusammenlaufen -- die Haelfte
     * eines Moduls ueber den Rand haengen (2026-09-14 im Bild gesehen).
     * Richtig ist das um (half + GAP) erodierte Sechseck: dieselbe Form,
     * Apothem um den Betrag kleiner. */
    const d = Math.max(0, (rimDist(ang) * (APOTHEM - half - SLOT_GAP)) / APOTHEM);
    return {
      x: Math.cos(ang) * d,
      z: Math.sin(ang) * d,
      half,
      rot: ((k >>> (i * 3 + 11)) % 12) * (Math.PI / 6), // Drehung in 30-Grad-Schritten
    };
  });
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _s = new THREE.Vector3();
const _c = new THREE.Color();

let group = null;
let days = null;   // InstancedMesh; userData.slots[i] = { hex, day, top, base } | null
let crates = null;
const terrain = new Map(); // Kit-Skin: Sorten-Index -> InstancedMesh (Geometrie und Material aus skin.mjs)
const stacksOf = (hgt, kh) => Math.max(1, Math.round(hgt / kh)); // Kisten je Tag: Balkenhoehe in Kistenhoehen

function mount(scene) {
  if (group) return;
  group = new THREE.Group();
  group.name = 'builds';
  scene.add(group);
}

/* Tagesbauten: Geometrie je Skin (Box oder Kiste). Aendert sich die
 * Geometrie, wird das Mesh neu angelegt — rebuild() setzt days auf null. */
function ensureDays(n, geo) {
  if (days && days.geometry === geo && days.instanceMatrix.count >= n) return;
  if (days) {
    group.remove(days);
    days.dispose();
  }
  days = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), Math.max(DAY_N * 16, Math.ceil(n * 1.5)));
  days.frustumCulled = false;
  days.castShadow = true;
  days.receiveShadow = true;
  days.userData.slots = [];
  group.add(days);
}

function ensureCrates(n) {
  if (crates && crates.instanceMatrix.count >= n) return;
  if (crates) {
    group.remove(crates);
    crates.dispose();
  }
  crates = new THREE.InstancedMesh(crateGeo, new THREE.MeshStandardMaterial({ color: TERRAIN, roughness: 0.9 }), Math.max(TERRAIN_PER_TILE * 16, Math.ceil(n * 1.5)));
  crates.frustumCulled = false;
  crates.castShadow = true;
  group.add(crates);
}

/* Kit-Gelaende: je Sorte ein InstancedMesh mit Kapazitaet fuer alle Plaetze
 * (im schlechtesten Fall faellt jeder Platz auf dieselbe Sorte). Geometrie
 * und Material gehoeren kit.mjs — nie dispose() darauf. */
function ensureTerrain(kinds, n) {
  kinds.forEach((k, i) => {
    const have = terrain.get(i);
    if (have && have.geometry === k.geometry && have.instanceMatrix.count >= n) return;
    if (have) {
      group.remove(have);
      have.dispose();
    }
    const m = new THREE.InstancedMesh(k.geometry, k.material, Math.max(16, Math.ceil(n * 1.5)));
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    terrain.set(i, m);
    group.add(m);
  });
}

function put(mesh, i, x, y, z, sx, sy, sz, color, rot = 0) {
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  _q.setFromAxisAngle(_up, rot);
  mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
  if (color) mesh.setColorAt(i, _c.set(color));
}

function sync(p, idx, now) {
  const crate = skin.role('dayCrate');
  const kinds = skin.role('terrain');
  const nCells = p.hexes.reduce((n, h) => n + cellsOf(h).length, 0);

  // Tagesbauten: clean = ein Kasten je Tag (Hoehe = scale.y), kit = Kisten je Tag
  if (crate) {
    let total = 0;
    for (const h of p.hexes) {
      if (h.hidden || !h.commitsByDay?.some(Boolean)) continue;
      for (let i = 0; i < DAY_N; i++) total += stacksOf(buildHeight(h.commitsByDay[i] ?? 0), crate.height);
    }
    ensureDays(total, crate.geometry);
  } else {
    ensureDays(DAY_N * p.hexes.length, boxGeo);
  }
  const slots = days.userData.slots;
  slots.length = 0;
  let di = 0;
  for (const h of p.hexes) {
    const w = worldOf(h, idx, now);
    const shown = !h.hidden;
    // Ohne einen einzigen Commit in 14 Tagen zeichnet 2D keine Skyline — hier auch nicht
    const has = shown && Boolean(h.commitsByDay?.some(Boolean));
    for (let i = 0; i < DAY_N; i++) {
      const n = h.commitsByDay?.[i] ?? 0;
      const hgt = buildHeight(n);
      const x = w.x + DAY_X0 + i * DAY_PITCH + DAY_W / 2;
      const z = w.z + DAY_BASE;
      const hot = app.dayHover?.hexId === h.id && app.dayHover.day === i;
      const color = hot ? HOT : n ? LIT : DIM;
      if (crate) {
        if (!has) continue; // keine Instanz, kein Slot: versteckte Felder brauchen im Stapelmodus keinen Platzhalter
        const k = stacksOf(hgt, crate.height);
        const slot = { hex: h, day: i, top: { x, y: w.y + k * crate.height, z }, base: { x, y: w.y, z } };
        for (let s = 0; s < k; s++, di++) {
          put(days, di, x, w.y + s * crate.height, z, 1, 1, 1, color);
          slots[di] = slot; // jede Kiste des Tages zeigt auf denselben Slot — pick.mjs trifft so jede Kiste als "diesen Tag"
        }
      } else {
        put(days, di, x, w.y, z, has ? 1 : 0, has ? hgt : 0, has ? 1 : 0, color);
        slots[di] = has ? { hex: h, day: i, top: { x, y: w.y + hgt, z }, base: { x, y: w.y, z } } : null;
        di++;
      }
    }
  }
  days.count = di;
  days.instanceMatrix.needsUpdate = true;
  if (days.instanceColor) days.instanceColor.needsUpdate = true;
  days.computeBoundingSphere();

  // Gelaende: clean = graue Kisten, kit = fuenf Sorten aus dem Manifest, Sorte aus dem Hash
  if (kinds) {
    ensureTerrain(kinds, EXTRA_SLOTS.length * nCells);
    const counts = new Array(kinds.length).fill(0);
    for (const h of p.hexes) {
      const shown = !h.hidden;
      // Kein Stueck in einer Steg-Bucht (tiles.mjs, Kit): die Buchten liegen
      // an der Hauptwabe. index.mjs ruft tiles.sync() vor builds.sync(), die
      // Buchten dieses Frames stehen also.
      const notches = tiles.notchesOf(h.id);
      cellsOf(h).forEach((cell, ci) => {
        const w = cellWorldOf(h, cell, idx, now);
        const k = hash(ci ? h.id + ':' + ci : h.id);
        terrainSlots(h, ci).forEach((t, j) => {
          // >>> statt >>: hash() liefert unsigned 32-Bit, mit gesetztem Bit 31
          // (an echten Repo-Pfaden beobachtet)
          // zieht der vorzeichenbehaftete Shift eine Folge von Einsen nach,
          // das Ergebnis wird negativ und "% kinds.length" bleibt negativ
          // (JS-Modulo behaelt das Vorzeichen des Dividenden) -- terrain.get()
          // faende dann keinen Eintrag.
          const ki = (k >>> (16 + j * 4)) % kinds.length;
          const size = kinds[ki].size;
          const cut = ci === 0 && notches.some((n) => inNotch(n, t.x, t.z, t.half));
          // Diagonale, nicht die groessere Kante: das Stueck steht gedreht
          // (t.rot), ein 34 x 20 grosses Modul braucht ueber Eck 39,4. Mit
          // max() hing an den Plattformecken jedes zweite Modul ueber dem Rand.
          const sc = shown && !cut ? Math.min(1, (t.half * 2) / Math.hypot(size[0], size[2])) : 0;
          put(terrain.get(ki), counts[ki]++, w.x + t.x, w.y, w.z + t.z, sc, sc, sc, null, t.rot);
        });
      });
    }
    kinds.forEach((_, i) => {
      const m = terrain.get(i);
      m.count = counts[i];
      m.instanceMatrix.needsUpdate = true;
    });
    if (crates) crates.count = 0;
  } else {
    ensureCrates(EXTRA_SLOTS.length * nCells);
    let n = 0;
    for (const h of p.hexes) {
      const shown = !h.hidden;
      cellsOf(h).forEach((cell, i) => {
        const w = cellWorldOf(h, cell, idx, now);
        // clean: eine Kiste je Platz, halb so gross wie der Platz -- der
        // Primitiv-Skin soll die Belegung zeigen, nicht sie ausfuellen.
        for (const t of terrainSlots(h, i)) {
          const sc = shown ? t.half * 0.55 : 0;
          put(crates, n++, w.x + t.x, w.y, w.z + t.z, sc, sc, sc, null, t.rot);
        }
      });
    }
    crates.count = n;
    crates.instanceMatrix.needsUpdate = true;
    for (const m of terrain.values()) m.count = 0;
  }
}

/* Skin-Wechsel: Tagesbauten und Kit-Gelaende verwerfen; der naechste sync()
 * baut mit role() neu. Die grauen Kisten bleiben — Geometrie und Material
 * sind eigene, ein Wechsel setzt nur ihren count. */
function rebuild() {
  if (days) {
    group.remove(days);
    days.dispose();
    days = null;
  }
  for (const m of terrain.values()) {
    group.remove(m);
    m.dispose();
  }
  terrain.clear();
}

function unmount() {}

const hitObjects = () => (days ? [days] : []);

/* Der Slot eines bekannten Tages — fuer dayAnchor() beim Rebind der Hover-Card. */
function slotOf(hexId, day) {
  if (!days) return null;
  return days.userData.slots.find((s) => s && s.hex.id === hexId && s.day === day) ?? null;
}

export { BUILD_H, DAY_N, TERRAIN_MAX_HALF, TERRAIN_PER_TILE, buildHeight, hitObjects, mount, rebuild, slotOf, sync, terrainSlots, unmount };
