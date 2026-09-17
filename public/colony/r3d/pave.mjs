/* Belag der Plattformen im Kit-Skin: ein prozedural gezeichnetes Raster aus
 * Bahnen im Verhaeltnis 3:5, zwei Helligkeiten im Schachbrett -- ein
 * gemaehter Rasen, kein Plattenweg (Andrés Korrektur vom 2026-09-14: die
 * erste Fassung mit zufaelliger Plattenhelligkeit und kraeftiger Fuge war
 * "zu wild").
 *
 * Grauwerte, nicht Farben: die Textur wird mit der Instanzfarbe multipliziert,
 * und die Instanzfarbe ist das Aktivitaetssignal (COLORS.state). Der Belag
 * darf es nur modulieren, nie ersetzen -- deshalb liegen alle Werte zwischen
 * 0,89 (Fuge) und 1,0 (helle Bahn) und nie darueber. Ueber 1,0 kappt der
 * 8-Bit-Kanal, das Relief verschwindet und die Flaeche wird flach hell (die
 * Falle aus ground.mjs::noiseTexture, Review-Fund I2 vom 2026-09-14).
 *
 * Dieselbe Textur dient als bumpMap: die Fuge liest sich dort als flache
 * Vertiefung. Das ist das "bisschen Relief" aus Andrés Wunsch vom
 * 2026-09-14, ohne eine einzige zusaetzliche Flaeche.
 *
 * UVs rechnet paveUVs() aus der Geometrie, nicht aus dem UV-Generator der
 * Geometrieklasse: Deckplatte (CylinderGeometry) und Buchtenplatte
 * (ExtrudeGeometry, notch.mjs) haetten sonst zwei verschiedene Massstaebe.
 * Waagerechte Flaechen bekommen das Raster aus x/z, senkrechte aus der
 * Wandrichtung und y -- so traegt auch der Sockel Platten statt eines ueber
 * seine ganze Hoehe verschmierten Streifens. */

import * as THREE from 'three';

const PLATE_W = 12;   // Plattenbreite in Welteinheiten
const PLATE_L = 20;   // Plattenlaenge, 3:5 zu PLATE_W
const COLS = 6;       // 6 x 12 = 72 -- gerade Zahl, sonst trifft an der
const ROWS = 4;       // 4 x 20 = 80    Kachelgrenze hell auf hell
const PATCH_U = COLS * PLATE_W;
const PATCH_V = ROWS * PLATE_L;
const JOINT = 1.0;    // Fugenbreite in Welteinheiten
/* Zwei Helligkeiten im Schachbrett, nah beieinander: das ist der gemaehte
 * Rasen aus Andrés Referenz. Die erste Fassung hatte je Platte eine
 * zufaellige Helligkeit, eine kraeftige Fuge und viel Koernung -- "zu wild".
 * Fuge nur noch knapp unter der dunkleren Platte, damit der Rand der Wabe
 * seine Hochkantstruktur behaelt (die gefaellt) und die Flaeche trotzdem
 * ruhig bleibt. */
const MOW_A = 0.93;
const MOW_B = 1.0;
const JOINT_V = 0.9;
const GRAIN = 3;      // Koernung in Stufen von 255

let tex = null;

/* Deterministisch aus Zeile und Spalte: Schachbrett plus eine winzige
 * Abweichung, damit die Flaeche nicht wie ein Druckraster wirkt. */
function shade(col, row) {
  const h = Math.imul((col + 1) * 374761393 + (row + 1) * 668265263, 1274126177);
  const base = (col + row) % 2 === 0 ? MOW_A : MOW_B;
  return base + ((((h >>> 16) & 0xff) / 255) - 0.5) * 0.024;
}

function texture(size = 512) {
  if (tex) return tex;
  const pu = size / PATCH_U; // Pixel je Welteinheit, waagerecht
  const pv = size / PATCH_V; // senkrecht (die Kachel ist nicht quadratisch)
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grey = (v) => '#' + Array(3).fill(Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  g.fillStyle = grey(JOINT_V);
  g.fillRect(0, 0, size, size);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      g.fillStyle = grey(shade(col, row));
      g.fillRect(col * PLATE_W * pu + (JOINT * pu) / 2, row * PLATE_L * pv + (JOINT * pv) / 2, PLATE_W * pu - JOINT * pu, PLATE_L * pv - JOINT * pv);
    }
  }
  // Koernung, damit die Flaeche aus der Naehe nicht wie lackiert wirkt
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.imul(i + 1, 2654435761) >>> 24) / 255 - 0.5;
    const d = n * 2 * GRAIN;
    img.data[i] = Math.min(255, Math.max(0, img.data[i] + d));
    img.data[i + 1] = img.data[i];
    img.data[i + 2] = img.data[i];
  }
  g.putImageData(img, 0, 0);
  tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* UVs in Einheiten der Kachel (PATCH_U x PATCH_V Welteinheiten). Erwartet eine
 * nicht-indizierte Geometrie mit Normalen -- beide Plattformgeometrien sind
 * das. Waagerecht (|n.y| > 0,5): Raster aus x/z. Senkrecht: u laeuft entlang
 * der Wand (Tangente = n x y), v mit der Hoehe. */
function paveUVs(geo) {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    if (Math.abs(ny) > 0.5) {
      uv[i * 2] = x / PATCH_U;
      uv[i * 2 + 1] = z / PATCH_V;
    } else {
      uv[i * 2] = (x * -nz + z * nx) / PATCH_U; // Tangente in der Waagerechten
      uv[i * 2 + 1] = y / PATCH_V;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/* Belag auf ein Material legen. bumpScale in Welteinheiten gedacht: die
 * Fuge soll sich als knappe Kante lesen, nicht als Relief einer Duene. */
function apply(mat) {
  mat.map = texture();
  mat.bumpMap = texture();
  mat.bumpScale = 0.6;
  mat.needsUpdate = true;
  return mat;
}

export { PATCH_U, PATCH_V, PLATE_L, PLATE_W, apply, paveUVs, texture };
