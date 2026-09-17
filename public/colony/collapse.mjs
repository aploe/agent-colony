/* Auf- und Zuklappen einer Familie: der gemerkte Zustand, der Treffer auf
 * den Chip und seine Masse.
 *
 * Der einzige gespeicherte Browserzustand im Projekt. Er vertraegt sich mit
 * "kein eigener Zustand", weil er nichts ueber Projekte aussagt, sondern nur,
 * was der Betrachter gerade sehen will — dieselbe Kategorie wie Zoom und Pan.
 * Geht er verloren, ist alles aufgeklappt, und das ist ein gueltiger
 * Zustand. */

import { HEX, app, planet } from './store.mjs';
import { hexCenter, toWorld } from './view.mjs';

const KEY = 'colony.collapsed';

/* Links auf halber Hoehe: die Label-Platte reicht bis rund cy-10, die
 * Skyline liegt bei cy-46 bis cy-60 in ±41, die Statuszeile bei cy+52 und
 * die Agentenfiguren unterhalb der Mitte. Auf der Hoehe der Feldmitte ist
 * das Hex am breitesten — dort ist Platz.
 *
 * -0.72 (erster Entwurf) sass zu nah an der linken Spitze des Hex: genau auf
 * y=0 laeuft die Aussenkontur der Familie in einer einzelnen Ecke zusammen
 * (zwei Silhouetten-Strecken treffen sich dort exakt bei lokal x=-HEX,
 * s. map.mjs), und der Rundkappenstift beider Strecken haeufte dort Tinte —
 * am Bildschirm sah der Chip aus, als klebe er auf dem Rand. -0.62 haelt
 * knapp 18 px Luft zu dieser Spitze und bleibt trotzdem weit genug vom
 * linkesten Punkt des Agenten-Bogens (rund cx-39, cy+18, siehe agents.mjs)
 * entfernt. Am echten Bild geprueft: eine Familie mit 7 Satelliten ohne
 * Agenten und eine mit 3 Agenten im Bogen. */
const CHIP_DX = -HEX * 0.62;
const CHIP_DY = 0;
const CHIP_R = 11;

function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    app.collapsed = new Set(Array.isArray(raw) ? raw : []);
  } catch {
    app.collapsed = new Set();
  }
  return app.collapsed;
}

function toggleCollapsed(id) {
  if (app.collapsed.has(id)) app.collapsed.delete(id);
  else app.collapsed.add(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...app.collapsed]));
  } catch {
    // Privater Modus oder blockierter Speicher: der Zustand gilt dann nur
    // fuer diese Sitzung. Kein Grund, die Karte anzuhalten.
  }
}

/* Der Chip wird vor der Wabe geprueft, sonst waehlte jeder Klick auf ihn
 * das Feld aus. Nur Container haben einen. */
function chipAt(sx, sy) {
  const p = planet();
  if (!p) return null;
  const w = toWorld(sx, sy);
  for (let i = p.hexes.length - 1; i >= 0; i--) {
    const h = p.hexes[i];
    if (h.hidden || !h.satellites) continue;
    const c = hexCenter(h);
    if (Math.hypot(w.x - (c.x + CHIP_DX), w.y - (c.y + CHIP_DY)) <= CHIP_R + 3) return h;
  }
  return null;
}

export { CHIP_DX, CHIP_DY, CHIP_R, chipAt, loadCollapsed, toggleCollapsed };
