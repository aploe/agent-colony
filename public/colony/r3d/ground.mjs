/* Boden des Kit-Skins: vier stumme Paletten (Config `ground` je Planet),
 * eine prozedurale Rausch-/Relieftextur fuer die Platte, die Streuung von
 * Stuecken ausserhalb der Plattformen -- Felsen auf jeder Palette; Gras,
 * Buesche, Baeume und Palmen dort, wo die Palette die Farben dafuer hat
 * (heute nur `gruen`) -- und seit 2026-09-14 eine Kueste an der Nordseite
 * der Kolonie fuer Paletten mit `water`: Sandstreifen, Schaumsaum, Wasser.
 * Die Kueste rechnet der Fragment-Shader der Platte (Patch ueber
 * `userData.shader`, bend.mjs haengt ihn hinter die Kruemmung), nicht eine
 * eigene Geometrie: die Kante bleibt in jeder Entfernung scharf, und nichts
 * streitet mit der Platte um die Tiefe. Alles hier ist Gelaende im Sinn der
 * Spec: keine Signalfarbe, nichts anklickbar, nichts animiert. Die Palette
 * ist Konfiguration, kein Betrachterzustand — darum nichts in localStorage.
 *
 * Die gruene Palette ist seit 2026-09-14 eine helle Wiese (Andrés Wunsch
 * nach einem Referenzbild: Rasen, kleine Baeume, Palmen, ein Strand an einer
 * Seite); vorher dunkles Moos. Jeder Wert haelt zu jeder Signalfarbe in
 * COLORS.state/git/agent/empty mindestens DeltaE76 15 (plate 21,8 zu active,
 * leaf 17,5 zu clean, grass 21,7 zu clean; Rechnung im Commit). */

import * as THREE from 'three';
import { anchorsFor } from '../anchors.mjs';
import { cellsOf } from '../hexmap.mjs';
import { HEX } from '../store.mjs';
import * as skin from './skin.mjs';
import { FLOOR_Y, TILE_R, cellWorldOf, expandedSpots, worldOf } from './world.mjs';

// plate = Platte, block = Gelaendebloecke (Sorte bleibt im Manifest
// moeglich, seit 2026-09-14 aber nicht mehr gelistet), rock = Felsen,
// stone = Findlinge, pebble = Schotter, ice = Gletscherbrocken.
// grass/leaf/wood = Bewuchs (Grasbueschel, Laub und Busch, Stamm),
// straw/scrub = Trockenbewuchs der Wueste, sand/water/deep/foam = Kueste.
// Drei Schluessel sind keine Farben, sondern das Trockenrelief der Platte
// (nur Helligkeit, nie Farbe -- so entsteht dort keine Signalfarbe):
// `dune` = [Staerke, Wellenlaenge, Winkel in Grad], `mottle` = Staerke der
// grossflaeckigen Fleckigkeit, `frozen` = die Kueste ist zugefroren.
// Welche Sorte auf einer Palette erscheint, entscheidet allein, ob die
// Palette alle Schluessel ihres Manifest-Eintrags kennt -- keine zweite
// Liste: `gelb` hat `leaf` und `wood` absichtlich nicht, sonst stuenden
// Laubbaeume und Palmen in der Wueste; `gruen` hat weder `stone` noch
// `pebble` noch `ice` und bleibt damit die Wiese, die sie ist. `blau`/`gelb` in der
// Abschluss-Fixwelle der Boden-Skins nachjustiert: die Startwerte lagen mit
// DeltaE76 bis 2,3 zu nahe an Signalfarben (`state.quiet`/`empty` bzw.
// `state.stale`). Am 2026-09-15 sind `rost`, `blau` und `gelb` ein zweites
// Mal gesetzt worden, diesmal an den Himmelsbildern gemessen (sky.mjs::
// DEFAULTS, Vordergrundzeilen ausgelesen): rost war ein graues Braun neben
// einem rostroten Himmel, blau ein Violett statt Eis, gelb ein Oliv statt
// Sand. Die Platte darf heller sein als der Bildvordergrund -- sie liegt im
// Licht, das Bild ist Ferne. Jeder Wert haelt zu jeder Signalfarbe in
// COLORS.state/git/agent/empty mindestens DeltaE76 15 (rost plate 17,8 zu
// git.missing, blau rock 18,4 zu git.norepo, gelb rock 22,6 zu
// state.stale). COLORS.planet bleibt aussen vor: Bildschirmhintergrund,
// keine Signalfarbe; haze/sky ebenso, das ist Kulisse in der Ferne.
// haze = Dunst am Horizont (Nebelfarbe, Kuppel auf Augenhoehe), sky = Zenit
// der Kuppel; den Verlauf daraus baut sky.mjs. Beides nur Kulisse in der
// Ferne, keine Signalfarbe.
const PALETTES = {
  rost: {
    plate: '#8e5233', block: '#a1633f', rock: '#5f3527',
    stone: '#9b5f42', pebble: '#6f4433',
    mottle: 0.26,
    haze: '#a4644a', sky: '#3a1c14',
  },
  gruen: {
    plate: '#5a9440', block: '#3a4a2c', rock: '#4f5a48',
    grass: '#88bb4f', leaf: '#6fae3c', wood: '#8a5a3a',
    sand: '#dcc98c', water: '#2e8fc4', deep: '#1c6aa3', foam: '#eef6f8',
    haze: '#9dbdd0', sky: '#1a3646',
  },
  blau: {
    plate: '#cfe3f2', block: '#b4d0e6', rock: '#98a6bc',
    ice: '#a9cfe4',
    mottle: 0.1,
    sand: '#dceaf5', water: '#9ec9de', deep: '#3f7fa0', foam: '#f2fbff', frozen: true,
    haze: '#7e9ab4', sky: '#1a2a44',
  },
  gelb: {
    plate: '#cfae6e', block: '#deba76', rock: '#b08a55',
    stone: '#c19a5d', pebble: '#9c7f4d',
    straw: '#c9ab5e', scrub: '#8f9a53',
    dune: [0.16, 170, 24], mottle: 0.1,
    haze: '#c4ab72', sky: '#3a2e16',
  },
};
const GROUND_PIECES = 120; // Startkapazitaet je Sorte; ensure() zieht nach

function paletteOf(p) {
  if (p?.ground && Object.hasOwn(PALETTES, p.ground)) return p.ground;
  return p?.theme === 'mars' ? 'rost' : 'gruen';
}

/* Wertrauschen, drei Oktaven, gekachelt: ein Canvas als map und bumpMap.
 * Werte 0,74..1,0 (nie ueber 1,0): die alte Formel (0,86..1,14) sprengte den
 * 8-Bit-Kanal nach oben, `Uint8ClampedArray` kappte 60 % der Texel auf 255 —
 * das Relief war unsichtbar (Review Task 1/2, Fund I2). Jetzt bleibt die
 * Platte nur dunkler als ihre Palettenfarbe, nie heller, und jeder Wert
 * passt in den Kanal. */
let noiseTex = null;
function noiseTexture(size = 256) {
  if (noiseTex) return noiseTex;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, y, cells) => {
    const gx = (x / size) * cells, gy = (y / size) * cells;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = smooth(gx - x0), fy = smooth(gy - y0);
    const w = (i, j) => hash((x0 + i) % cells, (y0 + j) % cells); // modulo cells: Kachel schliesst nahtlos
    const a = w(0, 0) + (w(1, 0) - w(0, 0)) * fx;
    const b = w(0, 1) + (w(1, 1) - w(0, 1)) * fx;
    return a + (b - a) * fy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = 0.5 * value(x, y, 8) + 0.3 * value(x, y, 32) + 0.2 * value(x, y, 128);
      const g = Math.round(255 * (0.74 + 0.26 * n));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  noiseTex = new THREE.CanvasTexture(c);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.repeat.set(PLATE_TILES, PLATE_TILES);
  noiseTex.colorSpace = THREE.NoColorSpace; // Multiplikator, keine Farbe
  return noiseTex;
}

/* Platte: HEX*400 breit (seit dem Horizont, vorher HEX*40), damit ihr Rand
 * jenseits des Nebels liegt (scene.mjs: Nebel bis HEX*120, Kamera hoechstens
 * HEX*45 von der Mitte, Rand also nie naeher als HEX*155) und die Flaeche
 * ohne sichtbare Kante in den Dunst der Kuppel uebergeht. PLATE_TILES haelt
 * die Kachelgroesse des Rauschens (rund 140 Welteinheiten je Kachel). */
const PLATE_SIZE = HEX * 400;
const PLATE_TILES = 240;

/* Kueste: an der Nordseite (-z; in der Standardansicht die ferne Seite, wie
 * im Referenzbild), nur fuer Paletten mit `water`. Die Wasserlinie liegt
 * COAST_GAP + SAND_W hinter der noerdlichsten Wabenmitte plus Plattformradius
 * und wandert mit der Kolonie (Bounds aller Felder, auch versteckter, wie die
 * Streuung); zwei Wellen aus Sinussummen mit Planeten-Seed (Wasserlinie und
 * Wiesenkante) machen sie unregelmaessig. Dieselbe Rechnung steht einmal in
 * GLSL (Platte) und einmal in JS (Streuung: kein Gras im Wasser, Palmen auf
 * dem Sand) -- eine bewusste Kopie; wer die eine aendert, aendert die andere. */
const COAST_GAP = HEX * 1.2;  // Wiese zwischen noerdlichster Plattformkante und Sand
const SAND_W = HEX * 1.4;     // Breite des Sandstreifens (ohne Welle)
const coast = { on: false, waterZ: 0, seed: 0 };
function coastWave(x, seed) {
  return Math.sin(x * 0.0125 + seed) * 22 + Math.sin(x * 0.031 + seed * 1.7) * 10 + Math.sin(x * 0.071 + seed * 2.9) * 4;
}
/* s > 0: landwaerts der Wasserlinie (Sand ab 0), s2 > 0: auf der Wiese.
 * Ohne Kueste liegt alles unendlich weit im Land. */
function shoreOf(x, z) {
  if (!coast.on) return { s: Infinity, s2: Infinity };
  const s = z - (coast.waterZ + coastWave(x, coast.seed));
  return { s, s2: s - SAND_W - coastWave(x * 1.3 + 700, coast.seed + 2) * 0.6 };
}

const coastU = {
  uCoast: { value: new THREE.Vector4(0, SAND_W, 0, 0) }, // waterZ, Sandbreite, Modus (0 aus, 1 Wasser, 2 Eis), Seed
  uSand: { value: new THREE.Color() },
  uWater: { value: new THREE.Color() },
  uDeep: { value: new THREE.Color() },
  uFoam: { value: new THREE.Color() },
  // Trockenrelief der Flaeche, beides nur Helligkeit: uDune = Duenen
  // (Staerke, Wellenlaenge, Winkel im Bogenmass), uMottle = grossflaeckige
  // Fleckigkeit. Staerke 0 heisst aus.
  uDune: { value: new THREE.Vector3(0, 1, 0) },
  uMottle: { value: 0 },
};
const COAST_GLSL = /* glsl */ `
uniform vec4 uCoast;
uniform vec3 uSand;
uniform vec3 uWater;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uDune;
uniform float uMottle;
varying vec3 vGround;
float coastWave(float x, float seed) {
  return sin(x * 0.0125 + seed) * 22.0 + sin(x * 0.031 + seed * 1.7) * 10.0 + sin(x * 0.071 + seed * 2.9) * 4.0;
}
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
// Wertrauschen, bilinear geglaettet. Anders als mottle() (Produkte von
// Sinus) hat es keine Vorzugsrichtung -- es taugt deshalb dort, wo ein
// Muster gerade nicht als Raster gelesen werden soll. Kein Backtick in
// diesem Block: der GLSL-Text ist ein Template-Literal.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Duenenkaemme: eine Richtung, die Kaemme seitlich verschoben, damit sie
// nicht schnurgerade laufen. Das Profil ist asymmetrisch wie eine echte
// Duene -- die Luvseite wird ueber drei Viertel der Wellenlaenge langsam
// heller bis zum Kamm, die Leeseite faellt auf dem letzten Viertel steil in
// den Schatten. Eine Sinuswelle hatte hier nur geblotcht: ohne die scharfe
// Kante liest das Auge keinen Kamm. Zwei Wellenlaengen uebereinander
// (die zweite 2,7-mal laenger, halb so stark), damit kein Kamm wie der
// andere aussieht.
float duneRow(vec2 p, float len, float ph) {
  float c = cos(uDune.z), sn = sin(uDune.z);
  float u = p.x * c + p.y * sn + ph;
  float v = -p.x * sn + p.y * c;
  u += 90.0 * sin(v * 0.0035) + 30.0 * sin(v * 0.0094 + 1.7);
  float w = fract(u / len);
  float lit = w < 0.75 ? smoothstep(0.0, 0.75, w) : 1.0 - 2.1 * smoothstep(0.75, 1.0, w);
  return lit - 0.45;
}
float duneShade(vec2 p) {
  return duneRow(p, uDune.y, 0.0) + 0.5 * duneRow(p, uDune.y * 2.7, 320.0);
}
// Fleckigkeit: drei langwellige Schwebungen, auf -1..1 normiert.
float mottle(vec2 p) {
  float m = sin(p.x * 0.0062 + 1.3) * sin(p.y * 0.0055)
          + 0.6 * sin(p.x * 0.0155 - 0.7) * sin(p.y * 0.0128 + 2.1)
          + 0.35 * sin((p.x + p.y) * 0.026 + 0.4);
  return m / 1.95;
}
// Eisloch: je Rasterzelle hoechstens eins, Mittelpunkt, Drehung und Sorte
// aus dem Hash der Zelle. Drei Sorten, damit nicht jedes Loch aussieht wie
// das daneben: runde Pfuetze, langgezogene Rinne, Doppelloch aus zwei
// verschmolzenen Kreisen. x = Loch, y = aufgebrochener Rand, z = wie dunkel
// das Wasser darin steht.
vec3 iceHole(vec2 p) {
  const float CELL = 130.0;
  vec2 g = floor(p / CELL);
  float a = hash21(g);
  if (a > 0.42) return vec3(0.0);
  vec2 c = (g + vec2(0.3 + 0.4 * hash21(g + 19.0), 0.3 + 0.4 * hash21(g + 47.0))) * CELL;
  float sorte = hash21(g + 73.0);
  float rot = 6.2832 * hash21(g + 91.0);
  float cs = cos(rot), sn = sin(rot);
  vec2 q = p - c;
  q = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
  // Rand unrund, aber nicht eckig: eine einzelne Schwingung mit vier Bauchen
  // las sich als Quadrat, drei plus fuenf ergeben eine Pfuetze.
  float ang = atan(q.y, q.x);
  float wob = 2.2 * sin(ang * 3.0 + a * 20.0) + 1.3 * sin(ang * 5.0 - a * 31.0);
  float rad = 9.0 + 12.0 * fract(a * 7.3);
  float dark = 0.32 + 0.26 * fract(a * 13.7);
  float rim = 3.5, d;
  if (sorte < 0.38) {
    d = length(q) + wob;
  } else if (sorte < 0.72) {              // Rinne: in einer Achse gestaucht
    d = length(q * vec2(1.0, 2.1)) + 0.7 * wob;
    rim = 2.2;
  } else {                                // Doppelloch, der zweite kleiner
    // smin statt min: ein hartes min() knickt im Schnittpunkt, und der Knick
    // stand als helle Nadel im Rand. Die Taille bleibt, die Spitze geht.
    // wob haengt am Winkel um q = 0 und dreht dort auf engstem Raum durch --
    // genau in der Taille. Nahe der Mitte deshalb ausgeblendet, sonst stand
    // dort ein Stachel.
    float o = rad * 0.62;
    float d1 = length(q - vec2(o, 0.0)), d2 = length(q + vec2(o, 0.0)) * 1.2;
    float t = clamp(0.5 + 0.5 * (d2 - d1) / 8.0, 0.0, 1.0);
    d = mix(d2, d1, t) - 8.0 * t * (1.0 - t) + 0.8 * wob * smoothstep(0.0, 10.0, length(q));
    rad *= 0.72;
    rim = 3.8;
  }
  return vec3(1.0 - smoothstep(rad - 2.5, rad, d),
              1.0 - smoothstep(0.0, rim, abs(d - rad - 2.0)),
              dark);
}`;
// Ersetzt map_fragment: das Rauschen bleibt ein Grauwert-Multiplikator
// (auf Wiese und Sand voll, im Wasser nur leicht), die Farbe kommt aus der
// Zone -- Wiese (Materialfarbe), Sand (nahe am Wasser dunkler: nass),
// Wasser (zum Horizont tiefer) mit einem Schaumsaum an der Wasserlinie und
// zwei blasseren Linien dahinter. wMask lebt bis roughnessmap_fragment
// weiter: Wasser glaenzt.
//
// Modus 2 (seit 2026-09-15, `blau`) ist dasselbe Ufer zugefroren: statt des
// Tiefenverlaufs eine glatte Eisflaeche mit einem wolkigen Frostschleier,
// statt der Schaumlinien ein Presseisruecken an der Kante, und darin
// Loecher in drei Sorten -- dunkles Wasser mit hellem, aufgebrochenem Rand.
// Das Eis glaenzt nur halb so stark wie Wasser. Die erste Fassung trug zwei
// gekreuzte Rissscharen; die lasen sich aus der Ferne als welliges
// Quadratraster und sind am selben Tag wieder raus.
//
// Duenen und Fleckigkeit liegen davor und gelten ueberall ausserhalb des
// Wassers: beides aendert nur die Helligkeit, nie die Farbe, damit auch hier
// keine Signalfarbe entsteht.
const COAST_MAP = /* glsl */ `
vec4 sampledDiffuseColor = texture2D( map, vMapUv );
float shade = sampledDiffuseColor.r;
float wMask = 0.0;
if (uDune.x > 0.0) shade *= 1.0 + uDune.x * duneShade(vGround.xz);
if (uMottle > 0.0) shade *= 1.0 + uMottle * mottle(vGround.xz);
if (uCoast.z > 0.5) {
  float s = vGround.z - (uCoast.x + coastWave(vGround.x, uCoast.w));
  float s2 = s - uCoast.y - coastWave(vGround.x * 1.3 + 700.0, uCoast.w + 2.0) * 0.6;
  vec3 col = diffuseColor.rgb;
  vec3 sand = uSand * mix(0.8, 1.0, smoothstep(0.0, 24.0, s));
  col = mix(col, sand, 1.0 - smoothstep(-2.0, 2.0, s2));
  wMask = 1.0 - smoothstep(-1.5, 1.5, s);
  vec3 water;
  if (uCoast.z > 1.5) {
    water = mix(uWater, uDeep, 0.35 * smoothstep(0.0, 600.0, -s));
    // Frostschleier statt Rissscharen: zwei Oktaven Wertrauschen, weich
    // ineinander. Nur wolkige Aufhellung, keine Linie und keine Richtung.
    float frost = 0.68 * vnoise(vGround.xz * 0.011) + 0.32 * vnoise(vGround.xz * 0.037);
    water = mix(water, uFoam, 0.3 * smoothstep(0.3, 0.95, frost));
    float ridge = 1.0 - smoothstep(0.0, 4.0, abs(s + 3.0));
    water = mix(water, uFoam, 0.8 * ridge);
    vec3 hole = iceHole(vGround.xz);
    hole.xy *= smoothstep(0.0, 30.0, -s);
    water = mix(water, uFoam, 0.9 * hole.y);
    water = mix(water, uDeep * hole.z, hole.x);
    shade = mix(shade, mix(0.9, 1.0, shade) * (0.97 + 0.05 * frost), wMask);
    wMask *= 0.5 * (1.0 - hole.x) + hole.x; // Loch glaenzt wie Wasser, Eis halb
  } else {
    water = mix(uWater, uDeep, smoothstep(0.0, 300.0, -s));
    float foam = 1.0 - smoothstep(0.0, 5.0, abs(s + 2.5));
    foam += 0.5 * (1.0 - smoothstep(0.0, 2.5, abs(s + 18.0 + 4.0 * sin(vGround.x * 0.05))));
    foam += 0.3 * (1.0 - smoothstep(0.0, 2.0, abs(s + 34.0 + 5.0 * sin(vGround.x * 0.037 + 1.0))));
    water = mix(water, uFoam, clamp(foam, 0.0, 1.0));
    shade = mix(shade, mix(0.92, 1.0, shade), wMask);
  }
  col = mix(col, water, 1.0 - smoothstep(-1.5, 1.5, s));
  diffuseColor.rgb = col;
}
diffuseColor.rgb *= shade;`;
function coastShader(shader) {
  Object.assign(shader.uniforms, coastU);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vGround;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>' + COAST_GLSL)
    .replace('#include <map_fragment>', COAST_MAP)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, wMask);');
}
let coastPalette = null;
function syncCoast(palette) {
  const pal = PALETTES[palette];
  if (coastPalette !== palette) {
    coastPalette = palette;
    if (pal.water) {
      coastU.uSand.value.set(pal.sand);
      coastU.uWater.value.set(pal.water);
      coastU.uDeep.value.set(pal.deep);
      coastU.uFoam.value.set(pal.foam);
    }
    const d = pal.dune;
    coastU.uDune.value.set(d ? d[0] : 0, d ? d[1] : 1, d ? (d[2] * Math.PI) / 180 : 0);
    coastU.uMottle.value = pal.mottle ?? 0;
  }
  coastU.uCoast.value.set(coast.waterZ, SAND_W, coast.on ? (pal.frozen ? 2 : 1) : 0, coast.seed);
}

const plateMats = new Map();
function plateMaterial(name) {
  let m = plateMats.get(name);
  if (m) return m;
  const tex = noiseTexture();
  m = new THREE.MeshStandardMaterial({ color: PALETTES[name].plate, map: tex, bumpMap: tex, bumpScale: 3, roughness: 1, metalness: 0 });
  m.userData.shader = coastShader; // ein Programm fuer alle Paletten; ohne Kueste bleibt uCoast.z 0
  plateMats.set(name, m);
  return m;
}

const hazeOf = (name) => PALETTES[name].haze;

/* Streuung, je Klasse ein eigenes Zellraster. cell = Rasterweite, fill =
 * Anteil belegter Zellen, jitter = Versatz in der Zelle (+- Anteil der
 * Zellbreite), band = so weit ueber eine Plattformkante hinaus reicht die
 * Klasse (muss innerhalb des Schattenkegels bleiben, den scene.mjs mit
 * SHADOW_MARGIN = HEX*5 fittet), blob = nur nahe einer
 * Wabenmitte (alles Steinerne) statt im Rechteck um die Kolonie mit
 * auslaufender Dichte (FADE), zone = wo die Klasse steht (land: nicht im
 * Wasser; meadow: nicht auf dem Sand; beach: oberer Sand und der Wiesensaum
 * dahinter). Gras wirft keinen Schatten: tausend Bueschel in der
 * Schattenkarte sieht niemand, kostet aber einen zweiten Durchlauf; Schotter
 * aus demselben Grund auch nicht.
 *
 * `boulder`/`pebble`/`ice` (2026-09-15) sind dieselben vier KayKit-Felsen in
 * anderer Groesse und anderer Palettenfarbe: Findlinge brechen die
 * Gleichfoermigkeit der Streuung, Schotter fuellt die kahlen Flaechen
 * dazwischen, Gletscherbrocken sind die Eisvariante fuer `blau`.
 * `drygrass`/`dryshrub` sind die Kenney-Bueschel und -Straeucher der Wiese,
 * duenner gestreut und strohfarben -- die Wueste braucht Bewuchs, aber
 * weniger und trockener als die Wiese. */
const CLASSES = {
  rock:     { cell: HEX,       fill: 0.85, jitter: 0.35, band: HEX * 3,   blob: true,  zone: 'land',   scale: [0.8, 1.2],  shadow: true },
  boulder:  { cell: HEX * 2.4, fill: 0.3,  jitter: 0.4,  band: HEX * 3.5, blob: true,  zone: 'land',   scale: [0.8, 1.4],  shadow: true },
  pebble:   { cell: HEX / 2.4, fill: 0.45, jitter: 0.45, band: HEX * 3.5, blob: true,  zone: 'land',   scale: [0.6, 1.5],  shadow: false },
  ice:      { cell: HEX * 1.6, fill: 0.4,  jitter: 0.4,  band: HEX * 3.5, blob: true,  zone: 'land',   scale: [0.7, 1.6],  shadow: true },
  grass:    { cell: HEX / 3,   fill: 0.7,  jitter: 0.45, band: HEX * 4,   blob: false, zone: 'meadow', scale: [0.7, 1.3],  shadow: false },
  bush:     { cell: HEX * 0.8, fill: 0.18, jitter: 0.4,  band: HEX * 4,   blob: false, zone: 'meadow', scale: [0.8, 1.3],  shadow: true },
  tree:     { cell: HEX * 1.1, fill: 0.3,  jitter: 0.4,  band: HEX * 4,   blob: false, zone: 'meadow', scale: [0.8, 1.25], shadow: true },
  palm:     { cell: HEX * 0.7, fill: 0.45, jitter: 0.4,  band: HEX * 5,   blob: false, zone: 'beach',  scale: [0.8, 1.2],  shadow: true },
  drygrass: { cell: HEX * 0.7, fill: 0.3,  jitter: 0.45, band: HEX * 4,   blob: false, zone: 'meadow', scale: [0.7, 1.3],  shadow: false },
  dryshrub: { cell: HEX * 1.5, fill: 0.22, jitter: 0.4,  band: HEX * 4,   blob: false, zone: 'meadow', scale: [0.8, 1.3],  shadow: true },
};
const classOf = (kind) => CLASSES[kind] ?? CLASSES.rock; // `block` und Unbekanntes wie Felsen
const MARGIN = 6;            // Abstand zwischen Stueck und Plattformrand
const FADE = HEX * 1.5;      // Rechteck-Klassen: Dichte laeuft ueber diese Breite am Fensterrand aus
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

let group = null;
const meshes = new Map(); // Sorten-Index -> InstancedMesh
const pieceMats = new Map(); // palette+kind -> MeshStandardMaterial
let placedKey = null;

function mount(scene) {
  if (group) return;
  group = new THREE.Group();
  group.name = 'ground';
  scene.add(group);
}

function hash32(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}
const unit = (h) => (h >>> 0) / 4294967296; // 0..1
// Zusaetzliche Avalanche-Mischung (wie murmur3s fmix), bevor ein Hash als
// Bruchzahl gelesen wird: `unit(h)` selbst liest fast nur die oberen Bits
// (die Division dominiert numerisch das Wertigste), und FNV-1a mischt genau
// dort schwach, wenn sich zwei Schluessel nur im letzten Zeichen
// unterscheiden -- wie bei `planetId + ':' + i` fuer i = 0..119. Ohne diese
// Stufe klumpte der Winkel: 49 von 120 Stuecken in einem einzigen 30-Grad-
// Sektor, vier Sektoren leer (Review, Fund I1).
const mix = (h) => (Math.imul(h ^ (h >>> 15), 2246822519) >>> 0);
// n-ter unabhaengiger Wert 0..1 aus demselben Zellen-Hash
const draw = (h, n) => unit(mix(h ^ Math.imul(n + 1, 0x9e3779b1)));

function pieceMaterial(palette, kind) {
  const key = palette + ':' + kind;
  let m = pieceMats.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ color: PALETTES[palette][kind], roughness: 1, metalness: 0 });
  pieceMats.set(key, m);
  return m;
}

// Palettenschluessel je Material des Modells (Gruppenreihenfolge): aus
// `paint` des Manifests, sonst rock. Eine Sorte ist auf einer Palette nur
// dabei, wenn die alle ihre Schluessel kennt -- so bleibt `rost` bei Felsen.
const paintKeys = (k) => k.materials.map((m) => k.paint?.[m.name] ?? 'rock');

/* Ein InstancedMesh je Sorte, die auf dieser Palette etwas zeigt, mit Platz
 * fuer `need` Instanzen; neu, wenn Geometrie, Palette oder Kapazitaet nicht
 * mehr passen. Sorten, die hier nichts zeigen, verlieren ihr Mesh. */
function ensure(eligible, palette, need) {
  for (const { k, i } of eligible) {
    const have = meshes.get(i);
    if (have && have.geometry === k.geometry && have.userData.palette === palette && have.instanceMatrix.count >= need[i]) continue;
    if (have) { group.remove(have); have.dispose(); }
    const mats = paintKeys(k).map((key) => pieceMaterial(palette, key));
    const m = new THREE.InstancedMesh(k.geometry, mats.length === 1 ? mats[0] : mats, Math.max(GROUND_PIECES, Math.ceil(need[i] * 1.5)));
    m.frustumCulled = false;
    m.castShadow = classOf(k.kind).shadow;
    m.receiveShadow = true;
    m.count = 0;
    m.userData.palette = palette;
    // Welcher Manifest-Eintrag hier steckt. Die Szene traegt nur die Meshes
    // der *zulaessigen* Sorten, in deren Reihenfolge -- wer von aussen ueber
    // `group.children` liest (Szenarien), kann daraus nicht auf den Index in
    // `kinds` schliessen, sobald eine Sorte ausfaellt. Solange nur Felsen
    // gestreut wurden, fiel das nicht auf: die ersten vier Eintraege waren
    // immer alle zulaessig.
    m.userData.kindIndex = i;
    m.userData.kind = k.kind;
    meshes.set(i, m);
    group.add(m);
  }
  for (const [i, m] of meshes) {
    if (eligible.some((e) => e.i === i)) continue;
    group.remove(m);
    m.dispose();
    meshes.delete(i);
  }
}

function inZone(zone, x, z, half) {
  const { s, s2 } = shoreOf(x, z);
  if (zone === 'land') return s > half + 2;
  if (zone === 'meadow') return s2 > half + 4;
  return coast.on && s > SAND_W * 0.3 && s2 < HEX * 0.4; // beach
}

/* Eine Klasse streuen: jede Zelle (i, j) hat aus hash(planet:klasse:i,j) ihr
 * Stueck (ob ueberhaupt, Sorte, Versatz, Drehung, Groesse), unabhaengig
 * davon, wie gross die Kolonie gerade ist. Fenster = Bounds aller Wabenmitten
 * (auch versteckte) plus TILE_R + band. Ein Stueck faellt weg, wenn es einer
 * *sichtbaren* Plattform (`shown`, mit Hangar) naeher als TILE_R + halbe
 * Grundflaeche + MARGIN liegt, ausserhalb seiner Zone steht oder (blob)
 * keiner Wabenmitte (`centres`, auch versteckte) nahe genug ist. Felsen
 * behalten ihren alten Hash-Schluessel, damit sie auf `rost` nicht springen. */
function scatterClass(p, name, cls, members, centres, shown, b, placed) {
  const reach = TILE_R + cls.band;
  const x0 = b.minX - reach, x1 = b.maxX + reach, z0 = b.minZ - reach, z1 = b.maxZ + reach;
  for (let j = Math.floor(z0 / cls.cell); j <= Math.ceil(z1 / cls.cell); j++) {
    for (let i = Math.floor(x0 / cls.cell); i <= Math.ceil(x1 / cls.cell); i++) {
      const h = hash32(name === 'rock' ? p.id + ':' + i + ',' + j : p.id + ':' + name + ':' + i + ',' + j);
      const x = (i + 0.5 + (draw(h, 1) * 2 - 1) * cls.jitter) * cls.cell;
      const z = (j + 0.5 + (draw(h, 2) * 2 - 1) * cls.jitter) * cls.cell;
      let fill = cls.fill;
      if (!cls.blob) fill *= Math.min(1, Math.max(0, Math.min(x - x0, x1 - x, z - z0, z1 - z) / FADE));
      if (draw(h, 0) > fill) continue;
      const m = members[Math.floor(draw(h, 3) * members.length) % members.length];
      const scale = cls.scale[0] + draw(h, 4) * (cls.scale[1] - cls.scale[0]);
      // k.size ist schon die effektive Groesse (skin.mjs::role('groundTerrain')
      // hat k.fit hineinmultipliziert) -- half stimmt damit auch fuer Dateien,
      // die kit.mjs unter einer anderen Rolle zuerst gebacken hat.
      const half = (Math.max(m.k.size[0], m.k.size[2]) / 2) * scale;
      let nearest = Infinity;
      for (const c of shown) nearest = Math.min(nearest, Math.hypot(c.x - x, c.z - z));
      if (nearest < TILE_R + half + MARGIN) continue;
      if (cls.blob) {
        let any = Infinity;
        for (const c of centres) any = Math.min(any, Math.hypot(c.x - x, c.z - z));
        if (any > reach) continue;
      }
      if (!inZone(cls.zone, x, z, half)) continue;
      placed.push({ ki: m.i, x, z, rot: draw(h, 5) * Math.PI * 2, scale });
    }
  }
}

/* Deterministische Streuung auf festen Zellrastern in Weltkoordinaten (je
 * Klasse eins, scatterClass). Ausgespart sind nur *sichtbare* Plattformen:
 * unter zugeklappten Kindern waechst der Boden weiter (Andrés Befund vom
 * Nachmittag des 2026-09-14: kahle Flecken neben einem zugeklappten
 * Parent). Klappt eine Familie auf, verschwinden genau die Stuecke unter
 * den neuen Plattformen, alles andere steht -- das Raster haengt nicht an
 * der Kolonie. Vorher am selben Tag waren versteckte Kinder mit
 * ausgespart, und davor lag die Streuung in einem Ring um die Mitte der
 * *sichtbaren* Kolonie, mit Winkel und Radius aus dem Hash: jedes Auf- oder
 * Zuklappen verschob Mitte und Radius, und alle Felsen sprangen.
 *
 * Fenster, Blob-Reichweite und Wasserlinie haengen an den *aufgeklappten*
 * Positionen (world.mjs::expandedSpots), nicht an den tatsaechlichen: ein
 * zugeklapptes Kind steht sonst auf der Zelle seines Containers, mehrere
 * Kinder faellen auf einen Punkt zusammen, das Fenster schrumpft, und
 * Stuecke am Rand verschwinden (Andrés Befund vom 2026-09-15 -- vorher
 * benutzte diese Funktion `cellWorldOf` auch fuer versteckte Felder). Die
 * Ausspar-Zone (`shown`) bleibt dagegen an den tatsaechlich sichtbaren
 * Plattformen: nur unter denen darf kein Stueck stehen, ob eine Familie
 * gerade zu- oder aufgeklappt ist. Neu gesetzt nur, wenn sich die sichtbaren
 * Positionen oder ein Anker aendern (billiger Gate-Schluessel weiter unten,
 * ohne die Wurzeln fuer jeden Frame neu zu berechnen); waehrend einer
 * Umordnungsfahrt tauchen Stuecke unter den ziehenden Plattformen weg und
 * wieder auf, der Rest steht -- `expandedSpots()` selbst bleibt fuer die
 * ganze Fahrt stabil (siehe dort). */
function sync(p, idx, now) {
  const kinds = skin.role('groundTerrain');
  if (!kinds || !kinds.length) { // clean-Skin oder Manifest ohne groundTerrain -> keine Streuung
    for (const m of meshes.values()) m.count = 0;
    placedKey = null;
    return;
  }
  const palette = paletteOf(p);
  const pal = PALETTES[palette];
  coast.on = Boolean(pal.water);
  /* Jede Zelle zaehlt, nicht nur die Hauptwabe: ein Projekt mit fuenf Waben
   * haette sonst Baeume und Felsen auf vier davon stehen. */
  const shown = [
    worldOf(p.station, idx, now),
    ...p.hexes.filter((h) => !h.hidden).flatMap((h) => cellsOf(h).map((c) => cellWorldOf(h, c, idx, now))),
  ];
  /* Guenstiger Gate-Schluessel: die sichtbaren Positionen plus die Anker der
   * Wurzeln (beides ohnehin da, kein Trockenlauf noetig) reichen, um zu
   * erkennen, ob sich am aufgeklappten Layout etwas geaendert haben KANN.
   * Jeder reale Anlass -- Zuklappen, Umordnung, ein neu verankertes Projekt --
   * aendert entweder eine sichtbare Position oder einen Anker; expandedSpots()
   * (voller Trockenlauf mit Spiralsuche) laeuft darum erst dahinter, nicht
   * mehr in jedem Frame. */
  const anchorKey = [...anchorsFor(p.id)].map(([id, a]) => id + ':' + a.q + ',' + a.r).sort().join(';');
  const key = p.id + ',' + palette + ',' + anchorKey + '|' +
    shown.map((c) => Math.round(c.x) + ':' + Math.round(c.z)).join(';');
  if (key !== placedKey) {
    placedKey = key;
    const centres = expandedSpots(p);
    const xs = centres.map((c) => c.x);
    const zs = centres.map((c) => c.z);
    const b = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    coast.seed = draw(hash32(p.id + ':coast'), 0) * Math.PI * 2;
    coast.waterZ = b.minZ - TILE_R - COAST_GAP - SAND_W;

    const eligible = kinds
      .map((k, i) => ({ k, i }))
      .filter(({ k }) => paintKeys(k).every((key) => Object.hasOwn(pal, key)) && (classOf(k.kind).zone !== 'beach' || coast.on));
    const byClass = new Map();
    for (const e of eligible) {
      const name = Object.hasOwn(CLASSES, e.k.kind) ? e.k.kind : 'rock';
      if (!byClass.has(name)) byClass.set(name, []);
      byClass.get(name).push(e);
    }
    const placed = [];
    for (const [name, members] of byClass) scatterClass(p, name, CLASSES[name], members, centres, shown, b, placed);

    const counts = new Array(kinds.length).fill(0);
    for (const q of placed) counts[q.ki]++;
    ensure(eligible, palette, counts);
    counts.fill(0);
    for (const q of placed) {
      const k = kinds[q.ki];
      _p.set(q.x, FLOOR_Y, q.z);
      _q.setFromAxisAngle(_up, q.rot);
      // k.fit gleicht aus, dass kit.mjs Modelle je Datei cacht: rock_A/rocks_A
      // sind auch unter 'terrain' gelistet und dort zuerst gebacken (andere
      // Zielgroesse) -- ohne den Faktor bliebe die Instanz bei der falschen
      // Groesse stehen, obwohl k.size (und damit `half` oben) schon korrekt ist.
      _s.setScalar(q.scale * (k.fit ?? 1));
      meshes.get(q.ki).setMatrixAt(counts[q.ki]++, _m.compose(_p, _q, _s));
    }
    for (const [i, m] of meshes) {
      m.count = counts[i];
      m.instanceMatrix.needsUpdate = true;
    }
  }
  syncCoast(palette);
}

/* Skin-Wechsel: Instanz-Meshes und eigene Materialien verwerfen; Kit-Geometrien
 * gehoeren kit.mjs. Platte und Textur bleiben (skin-unabhaengig gecacht). */
function rebuild() {
  for (const m of meshes.values()) { group?.remove(m); m.dispose(); }
  meshes.clear();
  for (const m of pieceMats.values()) m.dispose();
  pieceMats.clear();
  placedKey = null;
}

const hitObjects = () => [];

export { GROUND_PIECES, PALETTES, PLATE_SIZE, SAND_W, coastWave, hazeOf, hitObjects, mount, paletteOf, plateMaterial, rebuild, shoreOf, sync };
