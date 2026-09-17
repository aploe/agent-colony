/* Himmel der 3D-Ansicht (Kit-Skin): eine Kuppel, die mit der Kamera faehrt
 * (Mittelpunkt = Kameraposition, Aequator also auf Augenhoehe, Radius
 * DOME_R), darauf entweder der Verlauf der Bodenpalette (haze -> sky, bis
 * 2026-09-14 in ground.mjs, die Kuppel damals fest auf Plattenhoehe) oder
 * ein Hintergrundbild. Seit 2026-09-14 hat jede der vier Bodenpaletten ihr
 * Bild (DEFAULTS, alle von André erzeugt); der Verlauf ist nur noch der
 * Rueckfall, solange ein Bild laedt oder wenn es fehlt. `sky` in der Config
 * eines Planeten ueberschreibt das Bild seiner Palette.
 *
 * Das Bild ist eine Kulisse, kein Panorama: es liegt AROUND-mal gespiegelt
 * um die Kuppel (gerade Zahl, damit der Saum bei u = 0 schliesst), seine
 * Hoehe in Breitengraden folgt aus dem Seitenverhaeltnis, und seine Zeile
 * `horizon` (Anteil von oben, Standard 0,5) liegt je Frame dort, wo die
 * gekruemmte Platte in Blickrichtung abbricht (horizonDeg(): die Tangente
 * von der Kamera an das Paraboloid aus bend.mjs). Der Rand wandert mit
 * Neigung und Zoom -- flach 14, Standard 23 Grad unter der Augenhoehe --,
 * und das Bild wandert mit; bei einer festen Zeile standen die Huegel in
 * der einen Ansicht frei ueber der Kante und waren in der anderen hinter
 * der Platte verschwunden. Zu den Seiten faellt die Kante tiefer, dort
 * bleibt ein Streifen Bildvordergrund zwischen Platte und Huegeln. Ueber
 * dem Bildrand wiederholt sich die oberste Zeile (Zenit; nie im Bild, die
 * Kamera schaut hoechstens 2,5 Grad ueber die Augenhoehe), unter ihm die
 * unterste (hinter der Platte). Der Nebel der Szene bekommt die Farbe der
 * Zeile knapp unter dem Horizont (haze()), damit die Platte in der Ferne
 * ins Bild auslaeuft, nicht in eine Palettenfarbe. Bis das Bild geladen
 * ist, und wenn es fehlt (Konsole), zeigt die Kuppel den Verlauf.
 *
 * Unbeleuchtet, von innen gesehen, ohne Nebel und ohne Tiefe, ungekruemmt
 * (userData.bend = false): eine Kulisse, kein Objekt. Keine Signalfarbe,
 * nichts anklickbar, nur 3D und nur im Kit-Skin -- 2D hat keinen Horizont. */

import * as THREE from 'three';
import { HEX } from '../store.mjs';
import * as bend from './bend.mjs';
import { camera, getControls } from './camera.mjs';
import { PALETTES, hazeOf, paletteOf } from './ground.mjs';

const DOME_R = HEX * 150;  // hinter dem Nebelende (scene.mjs: HEX*120), innerhalb camera.far (20000 = HEX*238)
const AROUND = 4;          // Bildwiederholungen um die Kuppel, gerade: gespiegelt schliesst der Saum
const HAZE_ROW = 0.03;     // Nebelfarbe aus der Zeile so weit unter dem Horizont (Anteil der Bildhoehe)
const BASE_URL = '/assets/sky/';
// Standardbild je Bodenpalette (PALETTES in ground.mjs). `horizon` ist die
// Bildzeile, die auf dem Plattenrand liegt, als Anteil von oben -- je Bild
// dort gemessen, wo der weiche Vordergrund beginnt. Nachweis der Herkunft
// in public/assets/sky/LICENSES.md.
const DEFAULTS = {
  rost:  { image: 'rost-tafelberge.png', horizon: 0.6 },
  gruen: { image: 'gruen-huegel.png', horizon: 0.56 },
  blau:  { image: 'blau-eisebene.png', horizon: 0.6 },
  gelb:  { image: 'gelb-hochebene.png', horizon: 0.62 },
};
const skyOf = (p) => p?.sky ?? DEFAULTS[paletteOf(p)] ?? null;

let dome = null;
const gradients = new Map(); // Palette -> MeshBasicMaterial
const images = new Map();    // Dateiname -> { ready, material, haze, tex, hDeg, horizon }
let loaded = () => {};

function mount(scene) {
  if (dome) return;
  dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 64, 32), gradientMaterial('gruen'));
  dome.name = 'dome';
  dome.userData.bend = false; // Himmel, keine Welt: bleibt ungekruemmt
  dome.visible = false;
  scene.add(dome);
}

/* Wer nach einem geladenen Bild einen Frame will (index.mjs: requestDraw),
 * haengt sich hier ein; sky.mjs darf index.mjs nicht importieren. */
function onLoad(fn) { loaded = fn; }

const show = (on) => { if (dome) dome.visible = on; };

/* Je Frame aus scene.syncEnv(): Kuppel unter die Kamera, Material des
 * Planeten -- das Bild, sobald es da ist (Horizontzeile auf den Plattenrand
 * gelegt), sonst der Verlauf seiner Palette. */
function sync(p) {
  if (!dome || !dome.visible) return;
  dome.position.copy(camera.position);
  const s = skyOf(p);
  const img = s ? imageOf(s) : null;
  const m = img?.ready ? img.material : gradientMaterial(paletteOf(p));
  if (dome.material !== m) dome.material = m;
  if (img?.ready) img.tex.offset.y = (1 - img.horizon) - (90 - horizonDeg()) / img.hDeg;
}

/* Senkung des Plattenrands in Blickrichtung, in Grad unter der Augenhoehe:
 * Tangente von der Kamera an das Paraboloid y = -d^2 / (2 R) um das
 * Kameraziel (bend.mjs), d = -a + sqrt(a^2 + 2 R h) mit a = waagerechtem
 * und h = senkrechtem Abstand der Kamera zum Ziel. Ohne Steuerung (vor dem
 * ersten Frame) der Wert der Standardneigung. */
function horizonDeg() {
  const c = getControls();
  if (!c) return 23;
  const dist = camera.position.distanceTo(c.target);
  const polar = c.getPolarAngle();
  const a = dist * Math.sin(polar);
  const h = dist * Math.cos(polar);
  const d = -a + Math.sqrt(a * a + 2 * bend.RADIUS * h);
  return THREE.MathUtils.radToDeg(Math.atan(d / bend.RADIUS));
}

/* Nebelfarbe des Planeten: aus dem Bild, sobald es da ist, sonst der Dunst
 * der Palette. Immer ein Hex-String, damit fog.color.set() beide gleich
 * (als sRGB) liest. */
function haze(p) {
  const s = skyOf(p);
  const img = s ? images.get(s.image) : null;
  return img?.haze ?? hazeOf(paletteOf(p));
}

/* Verlauf aus einem 1x256-Canvas: unter dem Horizont (v < 0,5) Dunst,
 * darueber bis v = 0,75 Dunst -> Zenit, darueber Zenit. Eins je Palette. */
function gradientMaterial(name) {
  let m = gradients.get(name);
  if (m) return m;
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 256;
  const ctx = c.getContext('2d');
  const haze = new THREE.Color(PALETTES[name].haze);
  const sky = new THREE.Color(PALETTES[name].sky);
  const mix = new THREE.Color();
  for (let y = 0; y < 256; y++) {
    const v = 1 - y / 255; // Zeile 0 = oben = v 1
    const t = Math.min(1, Math.max(0, (v - 0.5) / 0.25));
    const k = t * t * (3 - 2 * t); // smoothstep
    mix.copy(haze).lerp(sky, k);
    ctx.fillStyle = '#' + mix.getHexString();
    ctx.fillRect(0, y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  m = skyMaterial(tex);
  gradients.set(name, m);
  return m;
}

const skyMaterial = (map) => new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, fog: false, depthWrite: false });

/* Bild laden (einmal je Datei) und auf die Kuppel rechnen: SphereGeometry
 * bildet aequirektangular ab (u = Laengengrad, v = 0,5 + Breitengrad/180),
 * repeat und offset der Textur legen das Bild in dieses Netz: die unterste
 * Bildzeile liegt bei -horizonDeg - (1 - horizon) * hDeg Grad, also
 * offset.y = (1 - horizon) - (90 - horizonDeg) / hDeg. */
function imageOf(sky) {
  let e = images.get(sky.image);
  if (e) return e;
  e = { ready: false, material: null, haze: null, tex: null, hDeg: 0, horizon: 0.5 };
  images.set(sky.image, e);
  new THREE.TextureLoader().load(BASE_URL + sky.image, (tex) => {
    const img = tex.image;
    const horizon = Number.isFinite(sky.horizon) ? sky.horizon : 0.5;
    const hDeg = 360 / AROUND / (img.width / img.height); // Breitengrade, die das Bild deckt
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.MirroredRepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(AROUND, 180 / hDeg); // offset.y setzt sync() je Frame
    Object.assign(e, { tex, hDeg, horizon });
    e.material = skyMaterial(tex);
    e.haze = rowColor(img, Math.min(img.height - 1, Math.round((horizon + HAZE_ROW) * img.height)));
    e.ready = true;
    loaded();
  }, undefined, () => {
    console.warn(`Himmelbild ${BASE_URL}${sky.image} nicht geladen, die Kuppel zeigt den Verlauf der Palette`);
  });
  return e;
}

/* Mittlere Farbe einer Bildzeile als Hex-String (64 Abtastpunkte). */
function rowColor(img, row) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 1;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, row, img.width, 1, 0, 0, 64, 1);
  const d = ctx.getImageData(0, 0, 64, 1).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

export { AROUND, DOME_R, haze, horizonDeg, mount, onLoad, show, sync };
