/* Kamera und Orbit-Steuerung mit Leitplanken, plus die Zielfahrten (ganzer
 * Planet, eine Wabe) — das Gegenstueck zu fitTarget/hexTarget/animateView in
 * 2D. Ohne Zeichenaufruf: wer zeichnen will, haengt sich mit onChange an.
 * Die obere Abstandsgrenze ist keine Konstante mehr, sondern haengt an der
 * sichtbaren Kolonie (maxDist, syncLimits) -- seit der Kruemmung. */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { index } from '../hexmap.mjs';
import { HEX, planet } from '../store.mjs';
import { boundsOf, worldOf } from './world.mjs';

const FOV = 45;
// Leitplanken aus der Spec: nie platt von oben (25 Grad) und nie unter die
// Karte (70 Grad). Polar zaehlt von der Senkrechten aus.
const POLAR_MIN = THREE.MathUtils.degToRad(25);
const POLAR_MAX = THREE.MathUtils.degToRad(70);
const POLAR_DEFAULT = THREE.MathUtils.degToRad(50);
// Nah genug, dass eine Figur (12 hoch) die halbe Bildhoehe fuellt: bei 30
// Einheiten ist das Sichtfeld 25 hoch. Vorher HEX*2.5 = 210, da blieb ein
// Maennchen ein Fleck (Andrés Wunsch, 2026-09-14). Die Polar-Leitplanke
// haelt die Kamera auch nah ueber dem Boden.
const DIST_MIN = HEX * 0.35;
// Rauszoomen endet knapp hinter der Uebersicht (Andrés Wunsch, 2026-09-14,
// nach der Kruemmung in bend.mjs): weiter draussen wird der Planet zum
// Fleck auf einer Kugel und die Kruemmung albern. Der Deckel haengt an der
// sichtbaren Kolonie -- fitSpec() mal OUT_SLACK, mindestens OUT_MIN, damit
// eine Kolonie aus zwei Feldern nicht in der Nahaufnahme klemmt -- und
// wandert mit Auf-/Zuklappen und Planetenwechsel (syncLimits je Frame).
// DIST_CAP ist die absolute Grenze dahinter, ein Sicherheitsnetz.
const OUT_SLACK = 1.1;
const OUT_MIN = HEX * 6;
const DIST_CAP = HEX * 45;
/* three-Standard: links drehen, rechts schieben, Rad zoomt. Drehen ist das
 * Neue an dieser Ansicht, darum auf der Haupttaste. Eine Konstante, damit
 * die Entscheidung an einer Stelle steht. */
const MOUSE = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 20000);
let controls = null;
let notify = () => {};

function initControls(canvas, onChange) {
  if (controls) return;
  notify = onChange;
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;      // Traegheit braeuchte Frames ohne Anlass
  controls.minPolarAngle = POLAR_MIN;
  controls.maxPolarAngle = POLAR_MAX;
  controls.minDistance = DIST_MIN;
  controls.maxDistance = DIST_CAP; // syncLimits() zieht ihn nach dem ersten Frame auf die Kolonie
  controls.zoomToCursor = true;        // wie das Mausrad in 2D: der Punkt unter dem Cursor bleibt stehen
  controls.screenSpacePanning = false; // Schieben bleibt auf dem Boden
  controls.mouseButtons = MOUSE;
  controls.addEventListener('change', () => notify());
  camera.position.setFromSpherical(new THREE.Spherical(HEX * 12, POLAR_DEFAULT, 0));
  controls.update();
}

/* Kamera an Ziel und Abstand setzen, Blickrichtung (Polar/Azimut) behalten:
 * ein Planetenwechsel soll die Drehung nicht zuruecksetzen. */
function place(target, dist) {
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  controls.target.copy(target);
  camera.position.copy(target).addScaledVector(dir, THREE.MathUtils.clamp(dist, DIST_MIN, maxDist()));
  controls.update();
}

/* Ziel fuer den ganzen Planeten: Bounding Box der sichtbaren Mitten plus
 * Wabenrand, Abstand so, dass Breite und Hoehe der Box ins Sichtfeld passen.
 * Das Band zwischen HUD und Legende wird nicht nachgebildet (Plan,
 * Abweichung 5). */
function fitSpec(now = performance.now()) {
  const p = planet();
  if (!p) return null;
  const b = boundsOf(p, index(p.hexes), now); // sichtbare Felder plus Station, ein HEX Rand
  const target = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  // Gegen Breite und Hoehe fitten, nicht gegen die umschliessende Kugel:
  // die Kugel (halbe Diagonale) liess die Kolonie ein Drittel der Hoehe
  // fuellen. Ohne Foreshortening-Korrektur, also weiter konservativ.
  const hw = (b.maxX - b.minX) / 2;
  const hd = (b.maxZ - b.minZ) / 2;
  const dist = (Math.max(hd, hw / camera.aspect) / Math.tan(THREE.MathUtils.degToRad(FOV / 2))) * 1.1;
  return { target, dist };
}

/* Groesster erlaubter Abstand, siehe OUT_SLACK. Ohne Planet der Deckel. */
function maxDist(now = performance.now()) {
  const s = fitSpec(now);
  return s ? THREE.MathUtils.clamp(Math.max(s.dist * OUT_SLACK, OUT_MIN), DIST_MIN, DIST_CAP) : DIST_CAP;
}

/* Je Frame aus index.draw(): Deckel auf die sichtbare Kolonie nachziehen.
 * Steht die Kamera dahinter (Familie zugeklappt, Planet gewechselt), bleibt
 * der Deckel vorerst auf dem Ist-Abstand -- OrbitControls klemmt den Radius
 * in update(), die Kamera spraenge sonst beim naechsten Ziehen -- und sie
 * faehrt in einer kurzen Fahrt heran. Nicht mit einer Hand am Bild
 * (controls.state) und nicht, solange eine Fahrt laeuft, sonst startete sie
 * bei jeder Umordnungsfahrt je Frame von vorn. */
const IDLE = -1; // OrbitControls._STATE.NONE, nicht exportiert (three 0.186)
function syncLimits(now = performance.now()) {
  if (!controls) return;
  const max = maxDist(now);
  const d = camera.position.distanceTo(controls.target);
  if (d <= max + 0.5) {
    controls.maxDistance = max;
    return;
  }
  controls.maxDistance = d;
  if (!animating && controls.state === IDLE) animateTo({ target: controls.target, dist: max });
}

/* Ziel fuer eine Wabe: wie hexTarget() in 2D soll die Wabenhoehe HEX*sqrt(3)
 * 60 % des vertikalen Sichtfelds fuellen — die Nachbarn bleiben angeschnitten
 * im Bild, das ist die halbe Information. */
function focusSpec(h) {
  const p = planet();
  if (!p) return null;
  const w = worldOf(h, index(p.hexes));
  const dist = (HEX * Math.sqrt(3)) / 0.6 / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  return { target: new THREE.Vector3(w.x, w.y, w.z), dist };
}

let anim = 0;
let animating = false;
function cancelAnim() {
  anim++;
  animating = false;
}

function fitView() {
  cancelAnim();
  const s = fitSpec();
  if (s) place(s.target, s.dist);
}

/* Kurzer Weg statt Sprung, wie animateView() in 2D: Ease-out, letzter Frame
 * exakt auf dem Ziel, Token bricht eine abgeloeste Fahrt ab. Ziel und
 * Kameraposition werden linear interpoliert, die Blickrichtung bleibt. */
function animateTo(spec, ms = 250) {
  if (!spec) return;
  cancelAnim();
  const token = anim;
  const fromT = controls.target.clone();
  const fromP = camera.position.clone();
  const dir = new THREE.Vector3().subVectors(fromP, fromT).normalize();
  const toT = spec.target.clone();
  const toP = toT.clone().addScaledVector(dir, THREE.MathUtils.clamp(spec.dist, DIST_MIN, maxDist()));
  const t0 = performance.now();
  animating = true;
  function step(now) {
    if (token !== anim) return;
    const t = Math.min(1, (now - t0) / ms);
    const k = t >= 1 ? 1 : 1 - (1 - t) ** 3;
    controls.target.lerpVectors(fromT, toT, k);
    camera.position.lerpVectors(fromP, toP, k);
    controls.update();
    notify();
    if (t < 1) requestAnimationFrame(step);
    else animating = false;
  }
  requestAnimationFrame(step);
}

const focusHex = (h) => animateTo(focusSpec(h));
const animateFit = () => animateTo(fitSpec());
const getControls = () => controls;

export { animateFit, camera, cancelAnim, fitView, focusHex, getControls, initControls, maxDist, syncLimits };
