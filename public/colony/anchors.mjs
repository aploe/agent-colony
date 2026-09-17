/* Gemerkte Plaetze: welche Wurzel auf welcher Zelle steht, je Planet.
 *
 * Derselbe Zustandstyp wie `colony.collapsed` und mit "kein eigener Zustand"
 * aus demselben Grund vertraeglich: er sagt nichts ueber Projekte, nur
 * darueber, was der Betrachter sehen will. Geht er verloren, ordnet sich die
 * Karte einmal nach Gewicht — genau das, was sie heute bei jedem Laden tut.
 *
 * Verankert werden Wurzeln, nicht Kinder: Kinder werden bei jedem Layout um
 * ihre Wurzel verteilt, damit Auf- und Zuklappen nur die eigene Familie
 * bewegt. */

import { index, rootOf } from './hexmap.mjs';
import { app } from './store.mjs';

const KEY = 'colony.anchors';

// Zuletzt geschriebener Stand: `rememberAnchors` laeuft bei jedem Poll fuer
// jeden Planeten, meist ohne dass sich eine Wurzelposition aendert.
// `localStorage.setItem` trotzdem jedes Mal aufzurufen heisst, alle paar
// Sekunden zu schreiben, obwohl nichts Neues drinsteht — hier verglichen
// statt dort, weil saveAnchors() der einzige Schreibpfad ist.
let lastWritten = null;

function loadAnchors() {
  app.anchors = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const [planetId, cells] of Object.entries(raw ?? {})) {
      const m = new Map();
      for (const [id, c] of Object.entries(cells ?? {})) {
        if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) m.set(id, { q: c[0], r: c[1] });
      }
      app.anchors.set(planetId, m);
    }
  } catch {
    app.anchors = new Map();
  }
  return app.anchors;
}

function saveAnchors() {
  const out = {};
  for (const [planetId, m] of app.anchors) {
    out[planetId] = Object.fromEntries([...m].map(([id, c]) => [id, [c.q, c.r]]));
  }
  const json = JSON.stringify(out);
  if (json === lastWritten) return;
  try {
    localStorage.setItem(KEY, json);
    lastWritten = json;
  } catch {
    // Privater Modus oder blockierter Speicher: die Plaetze gelten dann nur
    // fuer diese Sitzung. Kein Grund, die Karte anzuhalten.
  }
}

function anchorsFor(planetId) {
  if (!app.anchors.has(planetId)) app.anchors.set(planetId, new Map());
  return app.anchors.get(planetId);
}

/* Nach jedem Layout: die Wurzelpositionen als Anker schreiben — neue
 * Familien sind damit ab ihrem ersten Platz verankert — und Anker von
 * Familien, die es nicht mehr gibt, entfernen. Sonst waechst der Speicher
 * mit jedem Projekt, das je auf der Karte war. */
function rememberAnchors(planetId, hexes) {
  const m = anchorsFor(planetId);
  const idx = index(hexes);
  const roots = hexes.filter((h) => rootOf(h, idx) === h);
  const live = new Set(roots.map((r) => r.id));
  for (const id of [...m.keys()]) if (!live.has(id)) m.delete(id);
  for (const r of roots) m.set(r.id, { q: r.q, r: r.r });
  saveAnchors();
}

/* Vor einer Umordnung: der Planet vergisst seine Plaetze und legt sich einmal
 * nach Gewicht. Die anderen Planeten bleiben, wie sie sind. */
function forgetAnchors(planetId) {
  app.anchors.set(planetId, new Map());
  saveAnchors();
}

export { anchorsFor, forgetAnchors, loadAnchors, rememberAnchors };
