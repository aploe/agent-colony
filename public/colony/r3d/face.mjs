/* Gesichter auf dem Visier der Kit-Hauptfigur (Andrés Wunsch vom
 * 2026-09-14, nach den Figuren im Reel): ein kleines Quadrat vor dem
 * Helmglas, am Kopfknochen, mit einer gezeichneten Miene -- Augen und Mund
 * aus dem Canvas, hell auf dem dunklen Glas. Die Miene folgt dem Zustand,
 * ist aber Beiwerk und kein Signal: Zustand tragen weiter Ring und
 * Hologramm (in 2D der Punkt). Offene Augen blinzeln gelegentlich.
 *
 *   work  (working)   ruhige Augen, kleiner Mund
 *   wait  (waiting)   grosse Augen, "o"-Mund -- schaut fragend her
 *   ask   (prompt)    weit offen, offener Mund -- das "!" aus 2D
 *   sleep (idle, sitzend)  geschlossene Augen, flacher Mund
 *
 * Texturen entstehen einmal je Miene (plus Blinzel-Variante) und werden von
 * allen Figuren geteilt; je Figur gibt es nur das Mesh und den Blinzel-
 * Zeitpunkt. Die Drohne (Kind) hat im Modell schon ein Gesicht. */

import * as THREE from 'three';

const HEAD_BONE = 'Head_05';
// Der Helm ist eine Kugel um den Kopfknochen: Radius 3,0 nach oben, 3,1
// nach vorn, 3,14 zur Seite, Mitte 0,1 hinter dem Knochen (Raycast am
// Modell, 2026-09-14). Die Miene liegt auf einer Kugelkappe knapp darueber
// -- eine flache Platte davor schwebte sichtbar vor dem Glas (Andrés Bild).
const HELM_R = 3.18;         // Kappe: ein Hauch ueber dem Glas, nirgends darunter
const HELM_BACK = 0.1;       // Kugelmitte hinter dem Knochen
const CAP_W = 0.55;          // halbe Breite der Kappe in rad (rund 3,5 Welteinheiten)
const CAP_H = 0.45;          // halbe Hoehe
const INK = '#e8f1ff';       // hell, leicht kalt: liest sich auf dem schwarzen Glas als Licht
const BLINK_MS = 130;
const BLINK_GAP = [2500, 6500];

// Kappe um +z (phi = pi/2, theta = pi/2), dann wie das Modell gedreht: die
// Kappenmitte zeigt entlang Knochen-+y (= Welt +z, Blickrichtung), das
// Kappen-Oben nach Knochen--z (= Welt +y). u laeuft von -x nach +x, also
// nicht gespiegelt fuer einen Betrachter vor der Figur.
const geo = new THREE.SphereGeometry(HELM_R, 24, 16, Math.PI / 2 - CAP_W, 2 * CAP_W, Math.PI / 2 - CAP_H, 2 * CAP_H).rotateX(-Math.PI / 2);
const mats = new Map(); // 'work' | 'work-blink' | ... -> MeshBasicMaterial

/* Miene ins Canvas: Koordinaten in einem 256x209-Bild, Augen auf 40 % Hoehe. */
function draw(kind, blink) {
  const W = 256;
  const H = Math.round((W * CAP_H) / CAP_W);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  const ex = [W * 0.34, W * 0.66];
  const ey = H * 0.42;
  const closedEye = (x, r, up) => {
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(x, ey + (up ? r * 0.4 : -r * 0.4), r, up ? Math.PI : 0, up ? 0 : Math.PI, false);
    ctx.stroke();
  };
  const openEye = (x, rx, ry) => {
    ctx.beginPath();
    ctx.ellipse(x, ey, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  const line = (w, y, lw) => {
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(W / 2 - w / 2, y);
    ctx.lineTo(W / 2 + w / 2, y);
    ctx.stroke();
  };
  const smile = (w, y, depth) => {
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(W / 2 - w / 2, y);
    ctx.quadraticCurveTo(W / 2, y + depth, W / 2 + w / 2, y);
    ctx.stroke();
  };
  const oh = (r, y) => {
    ctx.beginPath();
    ctx.ellipse(W / 2, y, r * 0.8, r, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  switch (kind) {
    case 'sleep':
      closedEye(ex[0], 18, true);
      closedEye(ex[1], 18, true);
      line(36, H * 0.72, 8);
      break;
    case 'wait':
      if (blink) { closedEye(ex[0], 22, false); closedEye(ex[1], 22, false); }
      else { openEye(ex[0], 22, 26); openEye(ex[1], 22, 26); }
      oh(13, H * 0.74);
      break;
    case 'ask':
      if (blink) { closedEye(ex[0], 26, false); closedEye(ex[1], 26, false); }
      else { openEye(ex[0], 26, 30); openEye(ex[1], 26, 30); }
      oh(20, H * 0.76);
      break;
    default: // work
      if (blink) { closedEye(ex[0], 18, false); closedEye(ex[1], 18, false); }
      else { openEye(ex[0], 16, 20); openEye(ex[1], 16, 20); }
      smile(44, H * 0.7, 14);
  }
  return c;
}

function material(kind, blink) {
  const key = kind + (blink ? '-blink' : '');
  let m = mats.get(key);
  if (m) return m;
  const tex = new THREE.CanvasTexture(draw(kind, blink));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mats.set(key, m);
  return m;
}

/* Gesicht an den Kopfknochen des Klons haengen. Der Knochen traegt die
 * Normierungsskala des Modells; Position und Groesse werden dagegen
 * herausgerechnet, damit sie in Welteinheiten stimmen. Die Kappe sitzt um
 * die Helmmitte, die 0,1 hinter dem Knochen liegt (Knochen-+y = Welt +z).
 * Ohne den Knochen (fremdes Modell): null, die Figur bleibt gesichtslos. */
function attach(model) {
  const head = model.getObjectByName(HEAD_BONE);
  if (!head) return null;
  model.updateMatrixWorld(true);
  const s = new THREE.Vector3();
  head.getWorldScale(s);
  const k = 1 / (s.x || 1);
  const mesh = new THREE.Mesh(geo, material('work', false));
  mesh.scale.setScalar(k);
  mesh.position.set(0, -HELM_BACK * k, 0);
  mesh.renderOrder = 1;
  head.add(mesh);
  return { mesh, kind: 'work', blink: false, nextBlink: performance.now() + 1500 + Math.random() * 3000 };
}

function kindOf(state, sit) {
  if (sit > 0.5) return 'sleep';
  if (state === 'waiting') return 'wait';
  if (state === 'prompt') return 'ask';
  return 'work';
}

/* Je Frame: Miene nach Zustand, Blinzeln nach Uhr. Material nur tauschen,
 * wenn sich etwas aendert. */
function update(face, state, sit, t) {
  const kind = kindOf(state, sit);
  let blink = false;
  if (kind !== 'sleep') {
    if (t >= face.nextBlink + BLINK_MS) face.nextBlink = t + BLINK_GAP[0] + Math.random() * (BLINK_GAP[1] - BLINK_GAP[0]);
    else if (t >= face.nextBlink) blink = true;
  }
  if (kind === face.kind && blink === face.blink) return;
  face.kind = kind;
  face.blink = blink;
  face.mesh.material = material(kind, blink);
}

export { attach, update };
