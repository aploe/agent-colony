/* Text auf dem Canvas: kuerzen, umbrechen, als Platte setzen. Getrennt von
 * der Geometrie, weil jede Regel hier aus einer Messung am echten Kontext
 * kommt (`measureText`) und nicht aus der Wabenform. */

import { halfWidthAt } from './hex.mjs';
import { FILL, HEX, ctx } from './store.mjs';

/* Kuerzt auf die verfuegbare Breite statt auf eine geratene Zeichenzahl. */
function fitText(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

/* Projekttitel auf zwei Zeilen.
 *
 * Umgebrochen wird auch **nach Bindestrichen**, nicht nur an Leerzeichen:
 * Repo-Namen wie "acme-design-system" oder "shop4-webapp" haben keine
 * Leerzeichen und blieben sonst als "acme-design-s…" uebrig — zu wenig, um
 * Felder auseinanderzuhalten. Der Lookbehind haelt das Trennzeichen am Ende
 * des Tokens, damit der Bindestrich sichtbar bleibt. */
function wrapLabel(text, maxWidth, maxLines = 2) {
  const tokens = text.split(/(?<=[-\s])/);
  const lines = [];
  let line = '';
  for (const token of tokens) {
    const candidate = line + token;
    if (ctx.measureText(candidate.trim()).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line.trim());
      line = token;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line.trim()) lines.push(line.trim());
  // Letzte Zeile muss den Rest schlucken, darum hier hart auf Breite kuerzen
  return lines.slice(0, maxLines).map((l) => fitText(l, maxWidth));
}

/* Titel auf dunkler Platte: Hangar und Projektfelder teilen sich diese
 * Zeichenroutine, damit ihr Layout nie auseinanderlaufen kann - nur die
 * Textfarbe unterscheidet sie (die Hangar ist ein gestricheltes Feld, kein
 * Projekt). `cy` ist die Hex-Mitte, nicht die Zeilen-Position der Platte. */
function drawLabel(cx, cy, title, color) {
  ctx.textAlign = 'center';
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  const ly = cy - HEX * 0.36;
  const maxW = halfWidthAt(HEX * FILL, ly - cy) * 2 - 14;
  const lines = wrapLabel(title, maxW);
  const plateW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.fillStyle = 'rgba(13,17,23,.72)';
  ctx.beginPath();
  ctx.roundRect(cx - plateW / 2 - 5, ly - 9, plateW + 10, 3 + lines.length * 13, 4);
  ctx.fill();
  ctx.fillStyle = color;
  lines.forEach((l, i) => ctx.fillText(l, cx, ly + 3 + i * 13));
}

/* Eine Zeile unterhalb der Mitte, geklemmt auf die Hex-Breite an ihrer
 * eigenen Hoehe (`halfWidthAt`) -- dieselbe Regel wie bei `drawLabel` oben,
 * nur ohne Platte und ohne Umbruch: die Statuszeile ist immer eine Zeile.
 * Hangar ("N ohne Projekt"), gewoehnliche Felder ("12× · 3d") und
 * Satelliten (Final-Review-Fund: "kein eigenes Transkript" ragte hier in
 * den Nachbarn, weil bis dahin nie eine so lange Zeichenkette an dieser
 * Stelle stand) teilen sich diesen einen Aufruf -- damit ist jede
 * Statuszeile durch Konstruktion geschuetzt, nicht nur die, bei der es
 * schon einmal aufgefallen ist. */
function drawStatus(cx, cy, text, color) {
  ctx.textAlign = 'center';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = color;
  const dy = HEX * 0.62;
  const maxW = halfWidthAt(HEX * FILL, dy) * 2 - 8;
  ctx.fillText(fitText(text, maxW), cx, cy + dy);
}

export { drawLabel, drawStatus };
