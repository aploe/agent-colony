/* Kruemmung der Welt (seit 2026-09-14, Andrés Wunsch): die Kolonie soll auf
 * einem kleinen Planeten liegen. Kein echter Ball -- das Layout bleibt das
 * flache Hexraster aus hexmap.mjs und jede Wabe eine ebene Platte --, sondern
 * der Trick aus Animal Crossing: im Vertex-Shader sinkt jeder Punkt mit dem
 * Quadrat seines Abstands zum Kameraziel, y -= d^2 / (2 R). Nah am Ziel
 * passiert nichts, hinten faellt die Welt weg. Das Ziel wandert mit Schieben
 * und Fokus, der Scheitel liegt darum immer dort, wo man hinsieht.
 *
 * Ein Patch je Material (onBeforeCompile), gesetzt vor jedem Render fuer
 * alles in der Szene ausser der Himmelskuppel (userData.bend === false).
 * Gebogen wird nur die Projektion: worldPosition (Schattenkarte) und
 * Normalen bleiben flach, Licht und Schatten rechnen in der flachen Welt
 * und werden auf die gebogene gemalt. Wer ausserhalb des Shaders eine
 * Weltposition auf den Schirm bringt (CSS2D-Labels, sl-popup-Anker,
 * Raycasting), rechnet ueber drop()/place() dieselbe Senkung nach. */

import * as THREE from 'three';
import { HEX } from '../store.mjs';

// Scheitelradius des Paraboloids; ein echter Ball dieses Radius saehe nah
// am Scheitel genauso aus. Bei HEX*30 sinkt ein Feld 8 HEX vom Ziel um gut
// ein HEX (rund 90 Einheiten) und kippt 15 Grad nach aussen.
const RADIUS = HEX * 30;

const uBendK = { value: 1 / (2 * RADIUS) };
const uBendC = { value: new THREE.Vector2() };
const patched = new WeakSet();

// Ersetzt project_vertex aus three: dieselben Schritte (Batching, Instanzen),
// aber der Weg in den Blickraum fuehrt ueber die Weltposition, damit die
// Senkung dort ansetzt. modelMatrix und viewMatrix sind Standard-Uniforms
// jedes three-Vertex-Shaders; `transformed` kommt aus begin_vertex und traegt
// Skinning und Morphs schon.
const PROJECT = `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelMatrix * mvPosition;
vec2 bendD = mvPosition.xz - uBendC;
mvPosition.y -= dot( bendD, bendD ) * uBendK;
mvPosition = viewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

/* Eine Funktion fuer alle Materialien: three bildet den Programm-Cache-Key
 * aus onBeforeCompile.toString(), gleiche Funktion = gleicher Key. */
function onBeforeCompile(shader) {
  shader.uniforms.uBendK = uBendK;
  shader.uniforms.uBendC = uBendC;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uBendK;\nuniform vec2 uBendC;')
    .replace('#include <project_vertex>', PROJECT);
}

/* Ein Modul kann einen zweiten Patch mitgeben (`m.userData.shader`, heute
 * die Kueste der Platte in ground.mjs): erst die Kruemmung, dann seiner.
 * three bildet den Programm-Schluessel aus onBeforeCompile.toString() --
 * fuer die Huelle waere der bei jedem Extra gleich, darum ein eigener Key
 * aus dem Extra selbst. */
function patch(m) {
  if (patched.has(m)) return;
  patched.add(m);
  const extra = m.userData.shader;
  if (extra) {
    m.onBeforeCompile = (shader, renderer) => { onBeforeCompile(shader); extra(shader, renderer); };
    m.customProgramCacheKey = () => 'bend+' + extra.toString();
  } else {
    m.onBeforeCompile = onBeforeCompile;
  }
  m.needsUpdate = true; // falls schon kompiliert (Skin-Wechsel, Kit-Klone)
}

/* Vor jedem Render: neue Materialien patchen und Frustum-Culling aus -- die
 * Huellkugeln liegen in der flachen Welt; ein fernes Objekt, das flach ueber
 * dem oberen Bildrand laege, gehoert gebogen ins Bild. */
function apply(scene) {
  scene.traverse((o) => {
    const m = o.material;
    if (!m || o.userData.bend === false) return;
    o.frustumCulled = false;
    for (const x of Array.isArray(m) ? m : [m]) patch(x);
  });
}

/* Scheitel setzen -- einmal je Frame, vor den sync()-Laeufen der Module,
 * denn place() rechnet mit demselben Mittelpunkt wie der Shader. */
function sync(center) {
  uBendC.value.set(center.x, center.z);
}

/* Senkung an einer Stelle der flachen Welt, in Welteinheiten (>= 0). */
function drop(x, z) {
  const dx = x - uBendC.value.x;
  const dz = z - uBendC.value.y;
  return (dx * dx + dz * dz) * uBendK.value;
}

/* Ein Objekt ausserhalb des Shaders (CSS2DObject) an eine flache
 * Weltposition setzen: es landet dort, wo der Shader die Stelle hinmalt. */
function place(o, x, y, z) {
  o.position.set(x, y - drop(x, z), z);
}

export { RADIUS, apply, drop, place, sync };
