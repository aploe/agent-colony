/* Renderer, Szene, Licht, Boden, Groesse. Kein Zeichenaufruf ohne Anlass:
 * render() ruft index.mjs, nie eine Schleife von hier aus.
 *
 * Licht gehoert zur Szene, nicht zum Skin (Spec, Entscheidung 5): Hemisphaere
 * plus Sonne mit Schattenkarte, fuer clean und kit. Der Schattenkegel wird
 * auf die Kolonie gefittet (boundsOf), sonst waere er entweder zu grob oder
 * schnitte Plattformen ab. Boden: clean das Raster, kit eine Platte mit
 * Palette und Relief aus ground.mjs (Config `ground` je Planet) — nie in der
 * Naehe von aktiv-Gruen oder einer Git-Farbe, sonst taeuscht der Boden ein
 * Signal vor. Im Kit-Skin dazu ein Horizont (seit 2026-09-14, Andrés Wunsch):
 * die Himmelskuppel aus sky.mjs (Verlauf je Palette oder Hintergrundbild je
 * Planet) und Nebel in ihrer Dunstfarbe, in den die (jetzt sehr grosse)
 * Platte ausläuft -- flach gekippt sieht man so einen Planeten statt einer
 * Kante und Schwarz dahinter. Clean bleibt ohne.
 *
 * Kruemmung (bend.mjs): render() patcht vor jedem Bild alle Materialien der
 * Szene; Raster und Platte sind darum unterteilt, denn der Shader senkt
 * Punkte, keine Strecken. Die Kuppel ist Himmel und bleibt flach (sky.mjs). */

import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { HEX, app } from '../store.mjs';
import * as bend from './bend.mjs';
import { camera } from './camera.mjs';
import * as ground from './ground.mjs';
import * as skin from './skin.mjs';
import * as sky from './sky.mjs';
import { FLOOR_Y, boundsOf } from './world.mjs';

/* Sonnenstand. Bis 2026-09-14 (200, 400, 150) = 63 Grad ueber dem Horizont:
 * eine Plattform warf damit einen 5 Welteinheiten schmalen Saum, den man
 * neben ihrer Kante nicht als Schatten las -- die Waben sahen auf den Boden
 * geklebt aus (Andrés Befund). Jetzt 40 Grad: der Schatten wird so lang wie
 * der Koerper hoch ist, Plattformen, Bauten und Felsen stehen sichtbar auf
 * dem Boden. Flacher als 35 Grad wuerde das Skyline-Band seiner eigenen
 * Plattform ueber die halbe Wabe legen. */
const SUN_DIR = new THREE.Vector3(240, 250, 170).normalize();
// Deckt die Streuung aus ground.mjs ab, die bis inner + HEX*4 reicht, plus
// halbe Grundflaeche; Aufloesung 2048 bleibt bei rund einem Texel je
// Welteinheit. Als eigene Konstante statt eines Imports aus ground.mjs --
// scene.mjs darf ground.mjs weiterhin nicht fuer diesen Wert importieren.
const SHADOW_MARGIN = HEX * 5;
// Nebel erst jenseits der maximalen Kameradistanz (camera.mjs: HEX*45) plus
// Kolonieradius, damit die Kolonie selbst nie im Dunst steht; bei HEX*120 ist
// alles Dunst -- die Platte (Rand bei HEX*200, von der Kamera nie naeher als
// HEX*155) ist dort laengst verschwunden, es bleibt die Kuppel in Dunstfarbe.
const FOG_NEAR = HEX * 55;
const FOG_FAR = HEX * 120;
// Unterteilung der Platte fuer die Kruemmung: Zellen von 2 HEX, Sehnenfehler
// unter zwei Welteinheiten (bend.RADIUS), 40k Punkte.
const PLATE_SEGS = 200;

const scene = new THREE.Scene();
let webgl = null;
let css2d = null;
let grid = null;
let plane = null;
let sun = null;
let fitted = null; // letzter Schattenkegel, gegen Neuberechnung je Frame

function mount(canvas, overlay) {
  if (webgl) return;
  webgl = new THREE.WebGLRenderer({ canvas, antialias: true });
  webgl.setPixelRatio(pixelRatio());
  webgl.shadowMap.enabled = true;
  webgl.shadowMap.type = THREE.PCFSoftShadowMap;
  css2d = new CSS2DRenderer({ element: overlay });
  scene.background = new THREE.Color('#0d1117');

  /* Himmelslicht schwaecher, Sonne staerker als bis 2026-09-14 (0,9/1,8):
   * die Summe bleibt etwa gleich hell, aber der Anteil, der aus einer
   * Richtung kommt, steigt -- sonst hellt das Himmelslicht jeden Schatten so
   * weit auf, dass er auf dunklem Boden verschwindet. */
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2f28, 0.6));
  sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.castShadow = true;
  /* 2048, bewusst mit Treppe. Am 2026-09-14 ging es auf 4096: der Kegel
   * deckt die ganze Kolonie plus SHADOW_MARGIN ab, bei privat rund 1600
   * Welteinheiten Kantenlaenge, mit 2048 ist ein Texel 0,8 Einheiten gross,
   * und nah an einer Plattformkante (Andrés Screenshot) lief die
   * Schattenkante als sichtbare Treppe ueber den Boden. Am 2026-09-16 wieder
   * 2048: auf der Intel-iGPU brachte das im Kit 13,5 -> 17,8 fps, 1024 nichts
   * mehr (fundus/messungen/2026-09-16-ressourcen). Schatten sind seitdem per
   * Config `shadows` ohnehin aus; das hier gilt fuer den Fall, dass sie
   * jemand wieder einschaltet.
   *
   * Beide Bias-Werte klein: mit normalBias 1,5 und bias -0,0004 (erster
   * Versuch am selben Tag) loeste sich der Schatten vom Werfer -- eine Figur
   * oder ein Modul, das auf der Plattform steht, hatte gar keinen
   * Kontaktschatten mehr (Andrés Befund "die Schatten kleben nicht am
   * Objekt", im A/B-Bild bestaetigt). Der Betrag muss kleiner bleiben als
   * der kuerzeste Schatten, den etwas wirft, sonst verschwindet er ganz.
   * An der Kruemmung liegt es nicht: bend.mjs schreibt nur gl_Position, die
   * worldPosition bleibt flach -- Werfer und Empfaenger rechnen also in
   * derselben flachen Welt, und der Schatten wird mit der Flaeche gebogen. */
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00008;
  sun.shadow.normalBias = 0.15;
  scene.add(sun, sun.target);

  grid = gridLines(HEX * 40, 40, 0x1f2a36, 0x141b23);
  grid.name = 'grid'; // Szenarien finden es hierueber, seit es kein GridHelper mehr ist
  grid.position.y = FLOOR_Y;
  scene.add(grid);
  sky.mount(scene);
  rebuild();
  resize();
}

/* Wie GridHelper (Mittellinien in color1, Rest color2), aber jede Linie in
 * `divisions` Stuecke geteilt, damit sie sich mit dem Boden kruemmt. */
function gridLines(size, divisions, color1, color2) {
  const c1 = new THREE.Color(color1);
  const c2 = new THREE.Color(color2);
  const half = size / 2;
  const step = size / divisions;
  const pos = [];
  const col = [];
  for (let i = 0; i <= divisions; i++) {
    const k = -half + i * step;
    const c = i === divisions / 2 ? c1 : c2;
    for (let j = 0; j < divisions; j++) {
      const a = -half + j * step;
      const b = a + step;
      pos.push(a, 0, k, b, 0, k, k, 0, a, k, 0, b);
      for (let n = 0; n < 4; n++) col.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
}

/* Boden je Skin: Raster oder Platte plus Kuppel (sky.mjs) und Nebel. Die
 * Platte entsteht beim ersten Bedarf; Palette und Himmel setzt syncEnv je Frame. */
function rebuild() {
  const hasGround = skin.role('ground');
  if (hasGround && !plane) {
    plane = new THREE.Mesh(new THREE.PlaneGeometry(ground.PLATE_SIZE, ground.PLATE_SIZE, PLATE_SEGS, PLATE_SEGS).rotateX(-Math.PI / 2), ground.plateMaterial('rost'));
    plane.position.y = FLOOR_Y;
    plane.receiveShadow = true;
    scene.add(plane);
  }
  if (grid) grid.visible = !hasGround;
  if (plane) plane.visible = Boolean(hasGround);
  sky.show(Boolean(hasGround));
  scene.fog = hasGround ? (scene.fog ?? new THREE.Fog(sky.haze(null), FOG_NEAR, FOG_FAR)) : null;
}

/* Je Frame aus tiles.sync(): Schattenkegel auf die ganze Kolonie (auch
 * versteckte Felder, sonst spraenge er beim Auf- und Zuklappen und mit ihm
 * jeder Schatten), Bodenpalette und Himmel auf den Planeten (Config
 * `ground` und `sky`, sonst das Thema; Himmel in sky.mjs). Der Kegel wird nur neu gesetzt, wenn sich die Grenzen
 * geaendert haben (Umordnung, Planetenwechsel).
 * `now` kommt vom Aufrufer (derselbe Frame-Zeitpunkt wie fuer Plattformen
 * und Figuren), nicht aus einem eigenen performance.now() hier. */
function syncEnv(p, idx, now) {
  if (!sun) return;
  const b = boundsOf(p, idx, now, true);
  const key = [b.minX, b.maxX, b.minZ, b.maxZ].map(Math.round).join(',');
  if (key !== fitted) {
    fitted = key;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const r = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + SHADOW_MARGIN;
    sun.target.position.set(cx, 0, cz);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, r * 2);
    const c = sun.shadow.camera;
    c.left = -r; c.right = r; c.top = r; c.bottom = -r;
    c.near = 1; c.far = r * 4;
    c.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
  }
  if (plane) {
    const pal = ground.paletteOf(p);
    const mat = ground.plateMaterial(pal);
    if (plane.material !== mat) plane.material = mat;
    sky.sync(p);
    if (scene.fog) scene.fog.color.set(sky.haze(p));
  }
}

/* Schattenwurf an oder aus, Config `shadows` ueber den State. Geschaltet wird
 * nur die Sonne: ohne schattenwerfendes Licht zeichnet three.js keine
 * Schattenkarte, und die Materialien werden ohne Schattenabfrage neu
 * uebersetzt (die Lichtzahl steckt im Programm-Schluessel, three 0.186).
 * `shadowMap.enabled` bleibt an -- einen Wechsel daran bemerkt three nicht
 * von selbst, die Materialien behielten ihre alten Shader. */
function setShadows(on) {
  if (sun && sun.castShadow !== on) sun.castShadow = on;
}

/* Pixeldichte der 3D-Flaeche: die des Bildschirms, gedeckelt auf Config
 * `maxPixelRatio3d`, ohne Wert wie bisher auf 2. Nur 3D: am internen
 * Display (Dichte 2,5) war 1,5 hier kaum zu sehen, die Labels sind DOM und
 * bleiben scharf, die Flaeche hat 44 % weniger Pixel. In 2D machte dieselbe
 * Grenze die Schrift unscharf (2026-09-16, map.mjs::resize). */
const pixelRatio = () => Math.min(devicePixelRatio || 1, app.state?.config?.maxPixelRatio3d ?? 2);

/* Pixeldichte nachziehen, je Frame aus draw(): der Config-Wert kommt erst
 * mit dem ersten State (gemountet wird davor), und ein Fenster kann auf
 * einen Bildschirm mit anderer Dichte wandern. */
function syncPixelRatio() {
  if (webgl && webgl.getPixelRatio() !== pixelRatio()) resize();
}

function resize() {
  if (!webgl) return;
  webgl.setPixelRatio(pixelRatio());
  webgl.setSize(innerWidth, innerHeight, false); // Groesse kommt aus der CSS (100vw/100vh)
  css2d.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

function render() {
  if (!webgl) return;
  bend.apply(scene); // neue Materialien (Skin-Wechsel, Kit-Klone) vor dem ersten Bild
  webgl.render(scene, camera);
  css2d.render(scene, camera);
}

const renderer = () => webgl;

export { mount, rebuild, render, renderer, resize, scene, setShadows, syncEnv, syncPixelRatio };
