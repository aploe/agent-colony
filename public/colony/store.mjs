/* Was alle Module teilen: die Zeichenflaeche, die Farbtafel, die Konstanten
 * der Geometrie und der veraenderliche Zustand.
 *
 * Dieses Modul importiert selbst nichts. Wenn es das jemals tut, ist der
 * Schnitt falsch — alles andere haengt daran. */

const canvas = document.getElementById('colony');
const ctx = canvas.getContext('2d');

const COLORS = {
  // Fuellung = wann zuletzt ein Agent hier gearbeitet hat
  state: { active: '#2f7d4f', quiet: '#3b5566', stale: '#6b6234' },
  // Rand = Git-Arbeitszustand
  git: {
    dirty: '#e5484d',
    unpushed: '#f5a524',
    clean: '#3fb950',
    norepo: '#6f7785',
    missing: '#8b3a3a',
  },
  agent: { prompt: '#f0883e', working: '#3fb950', waiting: '#f5d90a', idle: '#6f7785' },
  planet: { earth: '#16311f', mars: '#3a1d16' },
  // Zusammengehoerigkeit einer Familie. Kein dritter Sinn fuer Farbe:
  // Fuellung bleibt Aktivitaet, Rand bleibt Git. `outline` zeichnet nur den
  // Aussenrand der Familie (Fixrunde 1: ein Wash pro Feld war im schmalen
  // Spalt zwischen zwei Waben nicht von einer Innenkante zu unterscheiden,
  // .14 Deckkraft war ausserdem als duenne Linie kaum sichtbar), `bridge`
  // bleibt die Linie *zwischen* Parent und Kind.
  family: {
    outline: 'rgba(143,211,255,.55)',
    outlineHot: 'rgba(143,211,255,.95)', // Silhouette der Familie unter dem Chip
    bridge: 'rgba(143,211,255,.75)',
    ghost: 'rgba(143,211,255,.35)', // wo zugeklappte Kinder wieder auftauchen wuerden
  },
  // Satellit ohne eigene Sessions: keine ehrliche Aktivitaetsfarbe, also
  // eine neutrale Flaeche statt einer geratenen.
  empty: '#222a35',
};

const HEX = 84;                       // Hex-Radius in Weltkoordinaten
/* Fuellanteil einer Wabe in 2D: die gezeichnete Flaeche ist FILL * HEX, der
 * Rest ist Fuge zum Nachbarn. Der Wert bleibt bei 0,96, weil genau diese
 * Fuge in 2D die Familien-Silhouette traegt (map.mjs) -- sie ist die einzige
 * Flaeche, die dort nicht schon Aktivitaet oder Git bedeutet. 3D rueckt
 * seit 2026-09-14 enger zusammen (world.mjs::TILE_FILL): dort zeigt die
 * Hubstufe die Familie, die Fuge wird nicht gebraucht. */
const FILL = 0.96;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 6;                   // Clamp fuer Wheel-Zoom und fitTarget()
const view = { x: 0, y: 0, zoom: 1 }; // Pan/Zoom
/* Der veraenderliche Teil des Zustands, gebuendelt in einem Objekt.
 *
 * Ein `export let app.state` waere fuer importierende Module nur lesbar — ES-Module
 * exportieren gebundene Namen, keine Variablen. Wer zuweist (`refresh()` setzt
 * `app.state`, die Zeiger-Events setzen `app.hover`), braucht darum ein Objekt, dessen
 * Felder alle Module gemeinsam sehen. */
const app = {
  state: null,
  planetId: null,
  selected: null,
  hover: null,
  dayHover: null, // { hexId, day }: Tagesbalken unter dem Cursor
  dayMax: 1, // staerkster Tag ueber alle Projekte, Bezug der Balkenhoehe
  lastPollMs: null, // Zeitpunkt des letzten geglueckten Fetch
  collapsed: new Set(), // Container-IDs, deren Kinder eingeklappt sind
  anchors: new Map(), // Planet -> (Wurzel-ID -> Zelle): gemerkte Plaetze
  lastReorderMs: 0, // Sperrfrist der automatischen Umordnung
  move: null, // { t0, ms } waehrend einer animierten Umordnung
  chipHover: null, // ID des Containers, ueber dessen Chip der Zeiger steht
  markedAgent: null, // Agenten-Key der angeklickten Figur; hebt die Panel-Zeile hervor
};

const planet = () => app.state?.planets.find((p) => p.id === app.planetId);

/* Mindestabstand zweier Animations-Frames in ms fuer beide Renderer, aus
 * Config `maxFps` (kommt mit dem State); 0 = ohne Grenze, auch vor dem
 * ersten Poll. Gemessen am 2026-09-16: solange eine Figur wartet oder
 * laeuft, zeichneten beide Renderer ohne Pause, und die Intel-iGPU lief am
 * Anschlag (fundus/messungen/2026-09-16-ressourcen). Drei ms Spielraum unter
 * 1000/maxFps, damit bei 60 Hz verlaesslich jedes zweite Bild trifft und
 * nicht je nach Zeitstempel-Rauschen mal das dritte. */
function frameGap() {
  const fps = app.state?.config?.maxFps;
  return fps > 0 ? 1000 / fps - 3 : 0;
}

export { COLORS, FILL, HEX, ZOOM_MAX, ZOOM_MIN, app, canvas, ctx, frameGap, planet, view };
