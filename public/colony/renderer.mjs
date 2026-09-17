/* Die Weiche zwischen den beiden Renderern. Der aktive ist ein Modul mit
 * der Fassade aus r2d/index.mjs; alle Exporte hier delegieren an ihn.
 *
 * r3d wird dynamisch importiert: es zieht three.js (rund 1 MB) nach, und
 * wer die 2D-Karte benutzt, soll das nie laden. r2d ist statisch, weil es
 * ohnehin die heutigen Module sind.
 *
 * Der Modus ist Betrachterzustand wie `collapsed` — derselbe localStorage-
 * Weg, dieselbe Begruendung (collapse.mjs): er sagt nichts ueber Projekte
 * aus, nur was man sehen will. Geht er verloren, ist es 2D. */

import * as r2d from './r2d/index.mjs';

const KEY = 'colony.renderer';

let active = r2d;
let current = '2d';
// Der erste 3D-Ladevorgang (three) dauert lang genug fuer einen zweiten
// Klick; zwei verschraenkte Wechsel koennten beide Flaechen sichtbar lassen.
let switching = false;

const load = (name) => (name === '3d' ? import('./r3d/index.mjs') : Promise.resolve(r2d));

function stored() {
  try {
    return localStorage.getItem(KEY) === '3d' ? '3d' : '2d';
  } catch {
    return '2d';
  }
}

function remember(name) {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // Privater Modus oder blockierter Speicher: der Modus gilt dann nur
    // fuer diese Sitzung.
  }
}

/* Vor dem ersten refresh(): der gemerkte Modus wird aktiv, die andere
 * Flaeche versteckt. Ein fehlgeschlagener 3D-Import (kein `npm install`,
 * Worktree ohne den `node_modules`-Symlink) darf die Seite nicht mit
 * verstecktem Canvas, totem Poll und leerem HUD zurueck lassen — darum
 * faellt initRenderer auf 2D zurueck statt den Fehler durchzureichen. */
async function initRenderer() {
  current = stored();
  if (current === '3d') r2d.unmount();
  try {
    active = await load(current);
    active.mount();
  } catch (err) {
    console.error('3D-Renderer nicht ladbar, zurueck zu 2D:', err);
    active = r2d;
    current = '2d';
    remember('2d');
    r2d.mount();
  }
}

/* Umschalten. Auswahl, Planet und zugeklappte Familien ueberleben, sie
 * liegen in `app`. Der Blickpunkt nicht — 2D kennt x/y/zoom, 3D eine
 * Orbit-Position, das laesst sich nicht ehrlich ineinander ueberfuehren.
 * Darum einmal fitView(). */
async function setMode(name) {
  if (switching || name === current) return;
  switching = true;
  try {
    active.unmount();
    try {
      active = await load(name);
      current = name;
    } catch (err) {
      // Derselbe Rueckfall wie in initRenderer: ohne ihn bliebe der Knopf
      // auf einer leeren Flaeche stehen, weil active.unmount() oben schon
      // die alte Flaeche versteckt hat.
      console.error('3D-Renderer nicht ladbar, zurueck zu 2D:', err);
      active = r2d;
      current = '2d';
    }
    remember(current);
    active.mount();
    active.resize();
    active.fitView();
    active.scheduleTick();
  } finally {
    switching = false;
  }
}

const mode = () => current;

const mount = () => active.mount();
const unmount = () => active.unmount();
const draw = (now = performance.now()) => active.draw(now);
const scheduleTick = () => active.scheduleTick();
const resize = () => active.resize();
const fitView = () => active.fitView();
const focusHex = (h) => active.focusHex(h);
const cancelAnim = () => active.cancelAnim();
const pickHex = (sx, sy) => active.pickHex(sx, sy);
const pickDay = (sx, sy) => active.pickDay(sx, sy);
const pickChip = (sx, sy) => active.pickChip(sx, sy);
const dayAnchor = (h, day) => active.dayAnchor(h, day);

export {
  cancelAnim, dayAnchor, draw, fitView, focusHex, initRenderer, mode, mount,
  pickChip, pickDay, pickHex, resize, scheduleTick, setMode, unmount,
};
