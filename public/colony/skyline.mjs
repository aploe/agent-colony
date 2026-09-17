/* Die Commit-Skyline ueber dem Label: ein Balken je Kalendertag, plus die
 * Treffererkennung fuer den Balken unter dem Cursor. */

import { HEX, app, ctx, planet } from './store.mjs';
import { hexCenter, toWorld } from './view.mjs';

/* Skyline: ein Balken je Kalendertag, 14 Tage, aeltester links, heute rechts.
 *
 * Pitch 6 mit 4 px Balken: 14 Slots sind 82 px breit (±41). An der Oberkante
 * der hoechsten Balken (-60 px unter Feldmitte... genauer: bei -0.55 HEX - 14)
 * ist das Hex noch ±45.8 px breit, das reicht mit knapp 5 px Rand. Breiter
 * geht es an dieser Hoehe nicht, weiter unten steht die Label-Platte.
 *
 * Die Hoehe misst sich am staerksten Tag ueber ALLE Projekte (app.dayMax), nicht
 * am staerksten Tag des Feldes: ein Feld mit drei Commits soll neben einem
 * mit 46 klein bleiben, sonst saehe jede Skyline gleich voll aus. Der Preis
 * ist, dass kleine Zahlen zu 2-px-Stummeln werden — die genaue Zahl steht in
 * der Hover-Card. */
const DAY_N = 14;
const DAY_PITCH = 6;
const DAY_W = 4;
const DAY_H = 14;
const DAY_X0 = -((DAY_N - 1) * DAY_PITCH + DAY_W) / 2;
const DAY_BASE = -HEX * 0.55;

function dayHeight(n) {
  // 2 px Minimum, damit ein einzelner Commit neben einem 46er-Tag nicht
  // verschwindet; leere Tage bekommen einen 1-px-Sockel, damit die
  // Zeitachse lesbar bleibt und der Hover einen Tag trifft.
  return n ? Math.max(2, Math.round((DAY_H * n) / app.dayMax)) : 1;
}

function drawSkyline(cx, cy, h) {
  const days = h.commitsByDay;
  if (!days || !days.some(Boolean)) return;
  for (let i = 0; i < DAY_N; i++) {
    const n = days[i] ?? 0;
    const hot = app.dayHover?.hexId === h.id && app.dayHover.day === i;
    ctx.fillStyle = n
      ? hot ? 'rgba(230,237,243,.95)' : 'rgba(230,237,243,.55)'
      : hot ? 'rgba(230,237,243,.5)' : 'rgba(230,237,243,.18)';
    ctx.fillRect(cx + DAY_X0 + i * DAY_PITCH, cy + DAY_BASE, DAY_W, -dayHeight(n));
  }
}

/* Welcher Tagesbalken liegt unter dem Cursor? Trefferzone ist das ganze
 * Skyline-Band (alle 14 Slots, volle Hoehe plus Rand), nicht der gezeichnete
 * Balken — ein 4x2-px-Stummel waere sonst kaum zu treffen. */
function dayAt(sx, sy) {
  const p = planet();
  if (!p) return null;
  const w = toWorld(sx, sy);
  for (const h of p.hexes) {
    if (h.hidden) continue;
    if (!h.commitsByDay?.some(Boolean)) continue;
    const c = hexCenter(h);
    const dx = w.x - (c.x + DAY_X0);
    const dy = w.y - (c.y + DAY_BASE);
    if (dx < -2 || dx > DAY_N * DAY_PITCH || dy > 3 || dy < -(DAY_H + 4)) continue;
    const day = Math.max(0, Math.min(DAY_N - 1, Math.floor(dx / DAY_PITCH)));
    return { hex: h, day, c };
  }
  return null;
}

export { DAY_BASE, DAY_PITCH, DAY_W, DAY_X0, dayAt, dayHeight, drawSkyline };
