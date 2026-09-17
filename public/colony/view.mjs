/* Die Kamera als reine Rechnung: Welches Ziel-View zeigt was, und welche Wabe
 * liegt unter dem Cursor.
 *
 * Bewusst ohne jeden Zeichenaufruf — die bewegten Teile (`fitView`,
 * `animateView`, `resize`) liegen in `map.mjs`, weil sie `draw()` brauchen.
 * Laegen sie hier, zeigte `map.mjs` auf `view.mjs` und zurueck. */

import { hexToPixel } from './hex.mjs';
import { cellsOf } from './hexmap.mjs';
import { HEX, ZOOM_MAX, ZOOM_MIN, app, planet, view } from './store.mjs';

const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/* Nutzbares Band zwischen den beiden fixierten Leisten, nicht das ganze
 * Fenster — sonst rutscht die Kolonie unter HUD oder Legende. Beide Zoom-Ziele
 * (ganzer Planet und einzelne Wabe) brauchen dieselben Masse; zweimal
 * gerechnet waeren sie beim naechsten HUD-Umbau lautlos auseinandergelaufen. */
function band() {
  const hudH = document.getElementById('hud').offsetHeight;
  const legendH = document.getElementById('legend').offsetHeight;
  return {
    usableW: innerWidth,
    usableH: innerHeight - hudH - legendH,
    // Die Bandmitte liegt um (hudH - legendH) / 2 von der Fenstermitte
    // versetzt, weil die beiden Leisten unterschiedlich hoch sind.
    offsetY: (hudH - legendH) / 2,
  };
}

/* Ziel-View, das den Weltpunkt (cx, cy) mittig ins Band legt. */
function centerTarget(cx, cy, zoom, b) {
  return { x: -cx * zoom, y: -cy * zoom + b.offsetY, zoom };
}

/* Ziel-View auf die Bounding Box der Felder berechnen: zentrieren *und*
 * skalieren. Reine Zentrierung (die alte fitView()) liess eine 5-Hex-Kolonie
 * bei 1500x950 auf rund 300 px zusammenschrumpfen, weil der Zoom nie an die
 * Fenstergroesse gekoppelt war. Eigene Funktion, weil der Doppelklick ins
 * Leere zum selben Ziel hin-tweent, ohne die Mathematik zu duplizieren. */
function fitTarget() {
  const p = planet();
  if (!p) return null;
  const b = band();

  // Alle Zellen, nicht nur die Hauptzelle: ein Projekt mit fuenf Waben ragt
  // sonst ueber den Rand des gefitteten Bildes hinaus.
  const pts = [
    hexToPixel(p.station.q, p.station.r),
    ...p.hexes.filter((h) => !h.hidden).flatMap((h) => cellsOf(h).map((c) => hexToPixel(c.q, c.r))),
  ];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  // Um HEX bzw. HEX*sqrt(3)/2 erweitert: die Punkte sind Hex-*Mitten*, ohne
  // diesen Rand wuerden die aeussersten Sechsecke am Fensterrand angeschnitten.
  const minX = Math.min(...xs) - HEX;
  const maxX = Math.max(...xs) + HEX;
  const minY = Math.min(...ys) - (HEX * Math.sqrt(3)) / 2;
  const maxY = Math.max(...ys) + (HEX * Math.sqrt(3)) / 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // 0.9, damit ein sichtbarer Rand bleibt statt die Kolonie exakt an die
  // Leisten und Fensterkanten zu klemmen.
  const zoom = clampZoom(
    Math.min(b.usableW / (maxX - minX), b.usableH / (maxY - minY)) * 0.9,
  );

  return centerTarget(cx, cy, zoom, b);
}

/* Ziel-View fuer eine einzelne Wabe: sie fuellt 60 % der Bandhoehe. Voll
 * ausgefuellt waere die Wabe randlos und man verloere die Nachbarschaft, die
 * auf dieser Karte die halbe Information ist — 60 % laesst die angrenzenden
 * Felder angeschnitten stehen. HEX*sqrt(3) ist die Hoehe eines Flat-top-Hex
 * (Kante oben/unten liegen bei ±HEX*sqrt(3)/2, die Ecken links und rechts). */
function hexTarget(h) {
  const b = band();
  const zoom = clampZoom((b.usableH * 0.6) / (HEX * Math.sqrt(3)));
  const c = hexToPixel(h.q, h.r);
  return centerTarget(c.x, c.y, zoom, b);
}

/* Wo eine Wabe gerade gezeichnet wird. Waehrend einer Umordnung gleitet sie
 * von ihrer alten zur neuen Zelle (`fromX`/`fromY` -> `q`/`r`), dieselbe
 * Ease-out-Kurve wie die Kamerafahrten in map.mjs. Sonst — und fuer Felder,
 * die erst durch diese Umordnung sichtbar werden und keine Von-Position
 * haben — die Zielposition.
 *
 * Alle Leser gehen hier durch, auch die Trefferpruefung: sonst klickt man
 * waehrend der Fahrt auf eine Wabe, die woanders gezeichnet wird. Zwei
 * Ausnahmen mit Grund: fitTarget und hexTarget rechnen mit dem Ziel, sonst
 * jagt der Zoom der Animation hinterher. */
function hexCenter(h, now = performance.now()) {
  const target = hexToPixel(h.q, h.r);
  const m = app.move;
  if (!m || h.fromX === undefined) return target;
  const t = Math.min(1, (now - m.t0) / m.ms);
  if (t >= 1) return target;
  const k = 1 - (1 - t) ** 3;
  return { x: h.fromX + (target.x - h.fromX) * k, y: h.fromY + (target.y - h.fromY) * k };
}

/* Mitte einer einzelnen Zelle eines Feldes. Ein Projekt kann mehrere Waben
 * belegen (hexmap.mjs::sizeOf); die Zusatzzellen haengen starr an der
 * Hauptzelle, also faehrt der ganze Klumpen bei einer Umordnung gemeinsam. */
function cellCenter(h, cell, now = performance.now()) {
  const c = hexCenter(h, now);
  if (cell.q === h.q && cell.r === h.r) return c;
  const base = hexToPixel(h.q, h.r);
  const p = hexToPixel(cell.q, cell.r);
  return { x: c.x + p.x - base.x, y: c.y + p.y - base.y };
}

/* Screen -> Welt, damit Klicks unabhaengig von Pan/Zoom treffen. */
function toWorld(sx, sy) {
  return {
    x: (sx - innerWidth / 2 - view.x) / view.zoom,
    y: (sy - innerHeight / 2 - view.y) / view.zoom,
  };
}

function hexAt(sx, sy) {
  const p = planet();
  if (!p) return null;
  const w = toWorld(sx, sy);
  // Rueckwaerts pruefen: spaeter gezeichnete Hexe liegen optisch oben
  for (let i = p.hexes.length - 1; i >= 0; i--) {
    const h = p.hexes[i];
    if (h.hidden) continue;
    for (const cell of cellsOf(h)) {
      const c = cellCenter(h, cell);
      if (Math.hypot(w.x - c.x, w.y - c.y) <= HEX * 0.92) return h;
    }
  }
  return null;
}

export { cellCenter, clampZoom, fitTarget, hexAt, hexCenter, hexTarget, toWorld };
