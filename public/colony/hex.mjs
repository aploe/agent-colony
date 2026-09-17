/* Hex-Geometrie: wo eine Wabe liegt, wie ihr Umriss verlaeuft, wie breit sie
 * auf einer bestimmten Hoehe ist. Reine Mathematik plus der Pfad auf dem
 * Kontext — hier steht nichts ueber Projekte oder Agenten. */

import { HEX, ctx } from './store.mjs';

/* Flat-top-Hex: Achsen so gewaehlt, dass Nachbarn lueckenlos anliegen. */
function hexToPixel(q, r) {
  return { x: HEX * 1.5 * q, y: HEX * Math.sqrt(3) * (r + q / 2) };
}

function hexPath(cx, cy, radius) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const px = cx + radius * Math.cos(a);
    const py = cy + radius * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/* Halbe Hex-Breite auf Hoehe dy. Flat-top-Hex hat Ecken bei (±R,0) und
 * (±R/2, ±R·√3/2) — zwischen Seiten- und Deckenecke laeuft die Kante linear.
 * Ohne das ist jede Textplatte breiter als das Feld und ragt in den Nachbarn. */
function halfWidthAt(radius, dy) {
  const halfHeight = (radius * Math.sqrt(3)) / 2;
  const k = Math.min(1, Math.abs(dy) / halfHeight);
  return radius * (1 - k / 2);
}

export { halfWidthAt, hexPath, hexToPixel };
