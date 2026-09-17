/* Laedt die Modelle des Kit-Skins und normiert sie einmal beim Laden. Kennt
 * Dateien, aber keine Rollen — die Zuordnung ist Sache von skin.mjs.
 *
 * Zwei Formen je Modell: `geometry` (gebacken, fuer InstancedMesh; null,
 * wenn das Modell mehr als ein texturiertes Material hat) und `scene` (Group mit dem
 * Original darunter, Normierung als Transform auf der Group — Klone ueber
 * SkeletonUtils.clone, damit geriggte Figuren ihre Knochen behalten).
 * Backen heisst: Welt-Matrizen der Meshes in Geometriekopien anwenden und
 * zu einer verschmelzen; danach setzen die Module ihre Instanzmatrizen wie
 * bei den Primitiven, put()/setInstance() aendern sich nicht. */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { fitSpec } from './fit.mjs';

const loader = new GLTFLoader();

function boxOf(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return { min: b.min.toArray(), max: b.max.toArray() };
}

/* Stege: die lange Grundflaechen-Achse muss +z sein (tiles.mjs richtet den
 * Steg mit lookAt aus, +z zeigt zum Kind). KayKits tunnel_straight_A ist
 * 2,0 lang in x — um 90 Grad drehen, bevor gemessen wird. */
function orient(scene, target) {
  if (target.across == null) return;
  const b = boxOf(scene);
  if (b.max[0] - b.min[0] > b.max[2] - b.min[2]) scene.rotation.y = Math.PI / 2;
}

function bake(gltfScene, target) {
  orient(gltfScene, target);
  const spec = fitSpec(boxOf(gltfScene), target);
  // Normierung auf einer inneren Group; die aeussere bleibt Identitaet, damit
  // ein Klon frei positioniert werden kann (figures.mjs setzt position auf
  // die aeussere) ohne die Verschiebung der Normierung zu verlieren.
  const inner = new THREE.Group();
  inner.add(gltfScene);
  inner.scale.setScalar(spec.scale);
  inner.position.set(spec.offset[0], spec.offset[1], spec.offset[2]);
  const group = new THREE.Group();
  group.add(inner);
  group.updateMatrixWorld(true);

  // Geometrie fuer Instanzen. Ein Material: alle Meshes zu einer Geometrie
  // verschmolzen. Mehrere Materialien ohne Textur (Kenney: flache Farbe je
  // Materialname, z.B. woodBark + leafsGreen): nach Material sortiert mit
  // Gruppen verschmolzen, `material` ist dann das Array in Gruppenreihenfolge
  // -- ein InstancedMesh traegt ein Material-Array wie ein Mesh, und
  // ground.mjs tauscht je Materialname die Palettenfarbe ein. Mehrere
  // Materialien mit Textur bleiben ohne Geometrie (nur als Klon brauchbar).
  const meshes = [];
  gltfScene.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
  const mats = [...new Set(meshes.map((m) => m.material))];
  const flat = mats.every((m) => !Array.isArray(m) && !m.map);
  let geometry = null;
  let material = null;
  if (meshes.length && (mats.length === 1 || flat)) {
    const partOf = (m) => {
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      return g;
    };
    const merge = (parts, groups) => (parts.length === 1 && !groups ? parts[0] : mergeGeometries(parts, groups));
    if (mats.length === 1) {
      geometry = merge(meshes.map(partOf), false);
      material = mats[0];
    } else {
      const byMat = mats.map((mat) => merge(meshes.filter((m) => m.material === mat).map(partOf), false));
      geometry = byMat.every(Boolean) ? merge(byMat, true) : null;
      material = mats;
    }
    if (!geometry) throw new Error('mergeGeometries lieferte null (gemischt indiziert/nicht-indiziert?)');
    geometry.computeBoundingSphere();
  }
  return { geometry, material, scene: group, size: spec.size };
}

/* manifest: Rollen -> { file, height|footprint|across, ... } (Zielgroessen
 * numerisch). Laedt jede Datei genau einmal, parallel; ein Fehler bricht
 * alles ab — der Aufrufer faellt dann auf clean zurueck. */
export async function load(manifest, baseUrl = '/assets/kit/') {
  const entries = [];
  const push = (e) => { if (e && e.file) entries.push(e); };
  for (const e of manifest.terrain ?? []) push(e);
  push(manifest.dayCrate);
  push(manifest.bridge);
  for (const e of manifest.station ?? []) push(e);
  for (const e of manifest.groundTerrain ?? []) push(e);
  push(manifest.figure?.main);
  push(manifest.figure?.sub);

  const models = new Map(); // file -> { geometry, material, scene, size }
  await Promise.all(entries.map(async (e) => {
    if (models.has(e.file)) return;
    models.set(e.file, null); // reserviert, gegen doppeltes Laden
    let gltf;
    try {
      gltf = await loader.loadAsync(baseUrl + e.file);
    } catch (err) {
      throw new Error('Kit-Modell nicht ladbar: ' + e.file + ' (' + (err?.message ?? err) + ')');
    }
    try {
      models.set(e.file, bake(gltf.scene, e));
    } catch (err) {
      throw new Error('Kit-Modell nicht verarbeitbar: ' + e.file + ' (' + (err?.message ?? err) + ')');
    }
  }));

  return {
    model(file) {
      const m = models.get(file);
      if (!m) throw new Error('Kit-Modell nicht geladen: ' + file);
      return m;
    },
    /* Klon fuer Einzelobjekte (Figuren, Station). Materialien bleiben
     * geteilt — wer je Klon eine Farbe braucht, klont das Material selbst. */
    clone(file) {
      return cloneSkeleton(this.model(file).scene);
    },
  };
}
