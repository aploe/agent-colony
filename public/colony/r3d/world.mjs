/* Gemeinsame Mathematik der 3D-Module: Weltkoordinaten, Hoehenstufen,
 * Plattformmasse. Importiert nur, was schon renderer-neutral ist —
 * hexCenter() rechnet in Weltkoordinaten und interpoliert waehrend einer
 * Umordnungsfahrt, deshalb traegt es hier unveraendert; dryLayout() und
 * anchorsFor() sind aus demselben Grund hier zulaessig (expandedSpots()).
 *
 * Achsen: 2D-x -> Welt-x, 2D-y -> Welt-z, Welt-y zeigt nach oben. Damit
 * gelten dasselbe Layout und dieselben Zahlen wie auf der 2D-Karte. */

import { anchorsFor } from '../anchors.mjs';
import { hexToPixel } from '../hex.mjs';
import { cellsOf, descendantsOf, dryLayout } from '../hexmap.mjs';
import { HEX, app } from '../store.mjs';
import { cellCenter, hexCenter } from '../view.mjs';

const STEP_Y = 10;          // eine Familienstufe: ein Parent steht so viel hoeher als seine sichtbaren Kinder
const MAX_DEPTH = 3;        // Deckel fuer die Hubstufen
/* Plattformradius. Enger als der 2D-Fuellradius (store.FILL = 0,96): in 2D
 * braucht die Familien-Silhouette den breiteren Spalt, in 3D zeigt die
 * Hubstufe die Familie (Andrés Wunsch vom 2026-09-14, die Waben sollen
 * zusammenruecken).
 *
 * Seit den Mehrfach-Waben lueckenlos: ein Projekt kann mehrere Zellen
 * belegen, und zwischen zwei Zellen desselben Projekts darf keine Fuge
 * stehen -- sonst liest sich der Klumpen als vier Plattformen mit einem
 * gemeinsamen Rand statt als eine Flaeche. Zwei verschiedene Projekte
 * trennen dann ihre beiden Leuchtkanten (je RIM_W breit), nicht mehr der
 * Spalt. */
const TILE_FILL = 1;
const TILE_R = HEX * TILE_FILL;
const TILE_H = 8;           // Plattformdicke
/* Platte direkt unter einer Plattform auf Stufe 0; 0,5 gegen Z-Fighting der
 * Unterseite. Am 2026-09-14 kurz auf -26 gezogen, damit die Waben auf einem
 * sichtbaren Sockel stehen und Schatten werfen -- Andrés Urteil am Bild:
 * gefaellt nicht, die Waben sollen flach auf dem Boden liegen. Zurueck. */
const FLOOR_Y = -(TILE_H + 0.5);
const LIFT_MS = 400;        // Hubfahrt beim Auf-/Zuklappen, wie animateMs der Umordnung
const BRIDGE_W = 9;         // Stegbreite, wie lineWidth der Bruecke in 2D; hier, weil skin.mjs sie braucht
const APOTHEM = (TILE_R * Math.sqrt(3)) / 2; // Mitte -> Kantenmitte der Plattform

/* Abstand Mitte -> Plattformkante in Richtung ang (Welt-xz, 0 = +x). Ecken
 * liegen bei 0, 60, 120 Grad (flat-top wie hexPath in 2D), Kantennormalen
 * bei 30, 90, 150; d ist der Winkel zur naechsten Kantennormale. Hier statt
 * in tiles.mjs, seit auch motion.mjs die Kante kennen muss. */
function rimDist(ang) {
  const sixth = Math.PI / 3;
  const d = (((ang % sixth) + sixth) % sixth) - Math.PI / 6;
  return APOTHEM / Math.cos(d);
}

/* Liegt der plattform-lokale Punkt (x, z) im flat-top-Sechseck mit
 * Umkreisradius r? Zwei Halbebenen-Paare reichen: die waagerechten Kanten
 * (|z| <= Apothem) und die vier schraegen (sqrt(3)|x| + |z| <= sqrt(3) r). */
function insideHex(x, z, r = TILE_R) {
  const s3 = Math.sqrt(3);
  return Math.abs(z) <= (r * s3) / 2 && s3 * Math.abs(x) + Math.abs(z) <= s3 * r;
}

/* Tiefe im Familienbaum: 0 = Wurzel. Ein Parent, den es im Array nicht
 * gibt, zaehlt wie in rootOf() als keiner. */
function depthOf(h, idx) {
  let d = 0;
  let p = h;
  while (p.parentId && idx.byId.has(p.parentId)) {
    d++;
    p = idx.byId.get(p.parentId);
  }
  return Math.min(d, MAX_DEPTH);
}

/* Hubstufe: wie viele sichtbare Familienstufen unter einer Wabe liegen.
 * Eine Wabe ohne sichtbare Kinder liegt auf dem Boden; ein Parent steht je
 * sichtbarer Kinderstufe eine Stufe hoeher (Andrés Entscheidung vom
 * 2026-09-14, kehrt die Spec um — dort lagen Kinder tiefer, und der Boden
 * musste unter der tiefsten Stufe liegen, was die Wurzeln schweben liess).
 * Y bedeutet weiter genau eines: Familienzugehoerigkeit als Form. Einmal
 * je index() gerechnet und in einer WeakMap gemerkt — jeder Frame baut
 * seinen eigenen index(). */
const liftCache = new WeakMap();
function liftOf(h, idx) {
  let m = liftCache.get(idx);
  if (!m) {
    m = new Map();
    for (const x of idx.byId.values()) {
      if (x.hidden) continue;
      let d = 0;
      let p = x;
      while (p.parentId && idx.byId.has(p.parentId)) {
        d++;
        p = idx.byId.get(p.parentId);
        if (!p.hidden) m.set(p.id, Math.max(m.get(p.id) ?? 0, Math.min(d, MAX_DEPTH)));
      }
    }
    liftCache.set(idx, m);
  }
  return m.get(h.id) ?? 0;
}

/* Ziel-Oberkante der Plattform: Hubstufe mal STEP_Y. */
const topY = (h, idx) => liftOf(h, idx) * STEP_Y;

/* Hubfahrt: die Oberkante gleitet in LIFT_MS von der zuletzt gezeichneten
 * Hoehe zur Zielstufe (Ease-out wie hexCenter). Gemerkt je Feld-ID; ein
 * Feld, das neu auftaucht, steht sofort auf seiner Stufe. lifting(now)
 * sagt index.mjs, ob noch Frames noetig sind — Frames nur auf Anlass. */
const lifts = new Map(); // id -> { y, from, to, t0 }
function liftY(h, idx, now) {
  const to = topY(h, idx);
  let s = lifts.get(h.id);
  if (!s) {
    s = { y: to, from: to, to, t0: -Infinity };
    lifts.set(h.id, s);
    return to;
  }
  if (s.to !== to) {
    s.from = s.y;
    s.to = to;
    s.t0 = now;
  }
  const t = Math.max(0, (now - s.t0) / LIFT_MS); // now vor t0 (fremde Uhr): am Start bleiben
  if (t >= 1) { s.y = s.to; return s.to; } // exakt einrasten, kein Rundungsrest
  const k = 1 - (1 - t) ** 3;
  s.y = s.from + (s.to - s.from) * k;
  return s.y;
}
const lifting = (now) => [...lifts.values()].some((s) => now - s.t0 < LIFT_MS);

/* Weltposition der Plattformmitte (Oberkante), waehrend einer Fahrt
 * interpoliert — in der Ebene ueber hexCenter, in der Hoehe ueber liftY.
 * Auch fuer p.station: ohne Kinder liegt sie auf 0. */
function worldOf(h, idx, now = performance.now()) {
  const c = hexCenter(h, now);
  return { x: c.x, y: liftY(h, idx, now), z: c.y };
}

/* Weltposition einer einzelnen Zelle eines Feldes. Hoehe und Hubfahrt
 * gelten fuer den ganzen Klumpen -- die Zusatzwaben eines Projekts stehen
 * auf derselben Stufe wie seine Hauptwabe. */
function cellWorldOf(h, cell, idx, now = performance.now()) {
  const w = worldOf(h, idx, now);
  if (cell.q === h.q && cell.r === h.r) return w;
  const c = cellCenter(h, cell, now);
  return { x: c.x, y: w.y, z: c.y };
}

/* Positionen, die alle Felder haetten, waere nichts zugeklappt: ein
 * Trockenlauf (hexmap.mjs::dryLayout) mit leerem collapsed-Set und den
 * aktuellen Ankern. Reine Zielzellen, keine Interpolation -- die Anker
 * stehen schon fest, bevor eine Umordnungsfahrt beginnt (app.reorder ruft
 * rememberAnchors direkt nach layout(), noch vor dem ersten Frame der
 * Fahrt), das Ergebnis bleibt darum fuer die ganze Fahrt stabil, waehrend
 * die tatsaechlich sichtbaren Plattformen weiter interpolieren.
 *
 * Grundlage fuer alles, was beim Zu- oder Aufklappen einer Familie weder
 * schrumpfen noch springen darf: Fenster, Blob-Reichweite und Wasserlinie
 * der Bodenstreuung (ground.mjs) sowie der Schattenkegel (boundsOf(...,
 * true)). Vorher nahmen beide die *tatsaechlichen* Positionen aller Felder,
 * auch versteckter -- ein zugeklapptes Kind steht aber auf der Zelle seines
 * Containers (hexmap.mjs::layout), nicht auf seiner eigenen. Sieben Kinder,
 * die vorher sieben Zellen belegten, meldeten nach dem Zuklappen alle
 * dieselbe Zelle, das Fenster schrumpfte, und Stuecke am Rand verschwanden
 * (Andrés Befund vom 2026-09-15). Nur x/z zaehlen, keine Hoehe -- die
 * Aufrufer brauchen beide nur fuer die Bodenebene. */
function expandedSpots(p) {
  const dry = dryLayout(p.hexes, new Set(), anchorsFor(p.id));
  const pts = [hexToPixel(p.station.q, p.station.r)];
  for (const h of p.hexes) {
    const d = dry.get(h.id);
    if (!d) continue;
    for (const c of d.cells ?? [{ q: d.q, r: d.r }]) pts.push(hexToPixel(c.q, c.r));
  }
  return pts.map((pt) => ({ x: pt.x, z: pt.y }));
}

/* Ausdehnung der Kolonie in der Bodenebene, plus ein HEX Rand -- dieselben
 * Grenzen wie camera.fitSpec() fuer die sichtbaren Felder (`all` falsch).
 * `all` wahr liefert stattdessen die aufgeklappten Positionen aus
 * `expandedSpots()`: scene.mjs fittet daran den Schattenkegel, damit der
 * beim Auf- und Zuklappen nicht springt. `now` reicht den Frame-Zeitpunkt
 * durch, sonst laese jeder worldOf()-Aufruf hier seinen eigenen
 * performance.now() und die Grenzen waeren waehrend einer Umordnungsfahrt in
 * sich inkonsistent. */
function boundsOf(p, idx, now = performance.now(), all = false) {
  const pts = all
    ? expandedSpots(p)
    : [
        worldOf(p.station, idx, now),
        ...p.hexes.filter((h) => !h.hidden).flatMap((h) => cellsOf(h).map((c) => cellWorldOf(h, c, idx, now))),
      ];
  const xs = pts.map((q) => q.x);
  const zs = pts.map((q) => q.z);
  return { minX: Math.min(...xs) - HEX, maxX: Math.max(...xs) + HEX, minZ: Math.min(...zs) - HEX, maxZ: Math.max(...zs) + HEX };
}

/* Kopie von drawnAgentsOf() aus map.mjs (dort nicht exportiert): welche
 * Figuren ein Feld tatsaechlich zeigt — bei zugeklapptem Container die der
 * Nachkommen mit, und seit dem 2026-09-14 nur Sessions mit lebendem Prozess.
 * Begruendung des Filters steht bei der Vorlage in map.mjs; beide Renderer
 * zeigen dieselben Figuren. Beim Herausziehen des gemeinsamen Kerns
 * zusammenlegen. */
const live = (agents) => agents.filter((a) => a.open !== false);

function drawnAgentsOf(h, idx) {
  if (h.hidden) return [];
  if (!app.collapsed.has(h.id)) return live(h.agents);
  return live([...h.agents, ...descendantsOf(h.id, idx).flatMap((k) => k.agents)]);
}

export { APOTHEM, BRIDGE_W, FLOOR_Y, LIFT_MS, MAX_DEPTH, STEP_Y, TILE_H, TILE_R, boundsOf, cellWorldOf, depthOf, drawnAgentsOf, expandedSpots, insideHex, liftOf, lifting, live, rimDist, topY, worldOf };
