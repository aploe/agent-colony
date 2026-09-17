/* Der Skin der 3D-Ansicht: Betrachterzustand wie der Renderer-Modus
 * (localStorage, verloren = clean), aber r3d-intern — ein Skin-Wechsel
 * tauscht Geometrien an Ort und Stelle, die Kamera bleibt stehen, nichts
 * wird neu importiert. Darum kein dritter Modus in renderer.mjs.
 *
 * Rollen statt Dateinamen: die Module fragen role('terrain'), nie nach
 * KayKit. Im Skin clean antwortet role() mit null, und jedes Modul nimmt
 * seine eigenen Primitive (Plan, Abweichung 1). Im Skin kit kommen
 * Geometrien aus kit.mjs, normiert auf die Zielgroessen des Manifests.
 *
 * Rueckfall: scheitert das Laden, bleibt clean, der Speicher merkt clean,
 * die Konsole nennt die Datei — dasselbe Muster wie 3D -> 2D. */

import * as THREE from 'three';
import * as pave from './pave.mjs';
import { DAY_W } from '../skyline.mjs';
import * as kit from './kit.mjs';
import { BRIDGE_W, TILE_R } from './world.mjs';

const KEY = 'colony.skin';
const MANIFEST_URL = '/assets/kit/manifest.json';
// Zielgroessen im Manifest duerfen Konstantennamen sein, damit dort keine
// Zahl steht, die im Code schon steht.
const CONSTANTS = { DAY_W, BRIDGE_W, TILE_R };

let current = 'clean';
let loaded = null;   // { manifest, kit }
let loading = null;  // Promise waehrend des Ladens
let platformMaterial = null;
const rebuilds = new Set();
let notify = () => {};

function stored() {
  try {
    return localStorage.getItem(KEY) === 'kit' ? 'kit' : 'clean';
  } catch {
    return 'clean';
  }
}

function remember(name) {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // privater Modus: der Skin gilt dann nur fuer diese Sitzung
  }
}

function resolveEntry(e) {
  const out = { ...e };
  for (const k of ['height', 'footprint', 'across']) {
    if (typeof out[k] !== 'string') continue;
    if (!Object.hasOwn(CONSTANTS, out[k])) throw new Error('Manifest: unbekannte Konstante ' + out[k]);
    out[k] = CONSTANTS[out[k]];
  }
  return out;
}

function resolveTargets(m) {
  return {
    ...m,
    terrain: (m.terrain ?? []).map(resolveEntry),
    dayCrate: resolveEntry(m.dayCrate),
    bridge: resolveEntry(m.bridge),
    station: (m.station ?? []).map(resolveEntry),
    groundTerrain: (m.groundTerrain ?? []).map(resolveEntry),
    figure: { main: resolveEntry(m.figure.main), sub: resolveEntry(m.figure.sub) },
  };
}

function ensureLoaded() {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = (async () => {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) throw new Error('Manifest nicht ladbar: HTTP ' + res.status + ' ' + MANIFEST_URL);
      const manifest = resolveTargets(await res.json());
      loaded = { manifest, kit: await kit.load(manifest) };
      return loaded;
    })().finally(() => { loading = null; });
  }
  return loading;
}

function apply(name) {
  current = name;
  remember(name);
  for (const fn of rebuilds) fn();
  notify();
}

/* Umschalten; liefert den Skin danach. Zwei Klicks waehrend eines Ladens
 * warten auf dieselbe Promise, kein doppeltes Laden. */
async function setSkin(name) {
  if (name !== 'kit' && name !== 'clean') return current;
  if (name === current) return current;
  if (name === 'kit') {
    try {
      await ensureLoaded();
    } catch (err) {
      console.error('Kit-Skin nicht ladbar, bleibe bei clean:', err);
      remember('clean');
      return current;
    }
    // Geteilte Lade-Promise: zwei gleichzeitige setSkin('kit')-Klicks haengen
    // beide an ensureLoaded(). Ohne die erneute Pruefung hier wendet der
    // zweite Aufruf den Wechsel noch einmal an, obwohl der erste ihn laengst
    // vollzogen hat -- jeder rebuild()-Haken und notify() feuerten doppelt.
    if (name === current) return current;
  }
  apply(name);
  return current;
}

/* Beim Mount: der gemerkte Skin wird aktiv. Wirft nie — ein fehlender
 * Asset-Ordner darf die 3D-Ansicht nicht mitreissen. Waehrend des Ladens
 * zeichnet die Szene clean; onChange() bringt danach den einen Frame. */
async function initSkin({ onChange } = {}) {
  if (onChange) notify = onChange;
  if (stored() === 'kit') await setSkin('kit');
}

const skin = () => current;
const onRebuild = (fn) => rebuilds.add(fn);

// InstancedMesh braucht genau eine Geometrie; kit.mjs liefert `geometry: null`
// fuer Modelle mit mehr als einem Material (siehe kit.mjs::bake()). Fuer die
// vier instanzierten Rollen ist das kein leiser Fallback, sondern ein
// Manifest-Fehler -- lieber laut mit Dateinamen als ein `null` an
// `new THREE.InstancedMesh(null, …)` weiterreichen.
function requireInstancedGeometry(m, file) {
  if (!m.geometry) throw new Error('Kit-Modell ohne einheitliche Geometrie (mehr als ein Material?), fuer InstancedMesh ungeeignet: ' + file);
  return m;
}

function role(name, arg) {
  if (current !== 'kit' || !loaded) return null;
  const { manifest, kit: k } = loaded;
  const part = (e) => {
    const m = requireInstancedGeometry(k.model(e.file), e.file);
    return { geometry: m.geometry, material: m.material, size: m.size };
  };
  switch (name) {
    case 'terrain':
      return manifest.terrain.map(part);
    case 'dayCrate': {
      const m = requireInstancedGeometry(k.model(manifest.dayCrate.file), manifest.dayCrate.file);
      return { geometry: m.geometry, height: m.size[1] };
    }
    case 'bridge': {
      const m = requireInstancedGeometry(k.model(manifest.bridge.file), manifest.bridge.file);
      return { geometry: m.geometry, material: m.material, length: m.size[2] };
    }
    case 'station':
      return manifest.station.map(part);
    case 'groundTerrain':
      // Streuung ausserhalb der Plattformen (ground.mjs): Geometrie aus dem Kit,
      // Material aus der Bodenpalette — der Atlas ist orange und wuerde auf
      // Gruen oder Blau falsch wirken. `rock_A.gltf`/`rocks_A.gltf` stehen
      // auch unter 'terrain' (Deko auf der Plattform) und werden dort zuerst
      // geladen -- kit.mjs cacht Modelle je Datei (derselbe Mechanismus wie
      // oben bei 'figure'), das gebackene m.size traegt also noch die
      // Zielgroesse der terrain-Rolle. `fit` skaliert auf die hier verlangte
      // Grundflaeche nach; ground.mjs multipliziert die Instanzskala damit.
      // `kind` ist die Klasse der Streuung (rock, grass, bush, tree, palm;
      // Vorgabe rock), `paint` bildet Materialnamen des Modells auf Schluessel
      // der Bodenpalette ab (Kenney: leafsGreen -> leaf, woodBark -> wood);
      // ohne Eintrag faerbt ground.mjs alles in `rock`. `materials` ist das
      // Array in Gruppenreihenfolge der gebackenen Geometrie (kit.mjs).
      return manifest.groundTerrain.map((e) => {
        const m = requireInstancedGeometry(k.model(e.file), e.file);
        const fit = e.footprint != null ? e.footprint / Math.max(m.size[0], m.size[2]) : e.height / m.size[1];
        return { geometry: m.geometry, materials: [].concat(m.material), size: m.size.map((v) => v * fit), kind: e.kind ?? 'rock', paint: e.paint ?? null, fit };
      });
    case 'figure': {
      const e = manifest.figure[arg === 'sub' ? 'sub' : 'main'];
      const m = k.model(e.file);
      // kit.mjs cacht Modelle je Datei -- nennt das Manifest dieselbe Datei
      // fuer main und sub mit verschiedener Zielhoehe (heute: derselbe
      // Astronaut, 12 vs. 8), gewinnt beim Backen die zuerst geladene
      // Rolle. Die andere skaliert ihren Klon selbst nach: e.height ist die
      // Zielgroesse dieser Rolle, m.size[1] die tatsaechlich gebackene.
      return {
        make: () => {
          const obj = k.clone(e.file);
          const s = e.height / m.size[1];
          obj.scale.setScalar(s);
          return obj;
        },
        height: e.height,
        hover: e.hover ?? 0,
      };
    }
    case 'ground':
      return { plane: true };
    case 'platformMaterial':
      platformMaterial ??= pave.apply(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 }));
      return platformMaterial;
    case 'hologramMaterial':
      // Signalfarbe als Leuchten, unabhaengig vom Licht; color schwarz, damit
      // nur emissive zaehlt. Neu je Aufruf: jede Figur pulst fuer sich.
      return new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(arg), emissiveIntensity: 1, transparent: true, opacity: 0.9 });
    default:
      return null;
  }
}

export { initSkin, onRebuild, role, setSkin, skin };
