/* Einstiegspunkt: Daten holen, Eingaben entgegennehmen, den Rest anstossen.
 *
 * Hier steht bewusst keine Zeichen- und keine Layoutlogik mehr — wer eine
 * sucht, findet sie ueber den Import, aus dem sie kommt. Aufteilung und
 * Begruendung: docs/HISTORIE.md. */

import { agentAt } from './colony/agents.mjs';
import { anchorsFor, forgetAnchors, loadAnchors, rememberAnchors } from './colony/anchors.mjs';
import { chipAt, loadCollapsed, toggleCollapsed } from './colony/collapse.mjs';
import { hideDayTip, showDayTip } from './colony/daytip.mjs';
import { layout, reorderNeeded } from './colony/hexmap.mjs';
import { renderHud } from './colony/hud.mjs';
import { animateView, cancelViewAnim, draw } from './colony/map.mjs';
import { renderPanel } from './colony/panel.mjs';
import * as R from './colony/renderer.mjs';
import { dayAt } from './colony/skyline.mjs';
import { app, canvas, planet, view } from './colony/store.mjs';
import { clampZoom, fitTarget, hexAt, hexCenter, hexTarget, toWorld } from './colony/view.mjs';

/* Wartet, bis die Shoelace-Komponenten im HUD hochgestuft UND gerendert
 * sind: whenDefined deckt das Hochstufen ab, der Frame danach das
 * asynchrone Fuellen des Shadow-DOM. */
const hudSettled = () =>
  customElements.whenDefined('sl-tooltip').then(() => new Promise((r) => requestAnimationFrame(r)));

async function refresh() {
  const res = await fetch('/api/state');
  app.state = await res.json();
  app.lastPollMs = Date.now();
  // Bezug fuer die Balkenhoehe: der staerkste Tag ueber alle Planeten, nicht
  // nur den sichtbaren — sonst spraenge jede Skyline beim Planetenwechsel.
  app.dayMax = Math.max(1, ...app.state.planets.flatMap((p) => p.hexes.flatMap((h) => h.commitsByDay ?? [])));
  // Positionen rechnen, bevor irgendetwas sie liest — `renderHud()`,
  // `fitView()` und das Rebinding der Auswahl unten haengen alle daran.
  for (const p of app.state.planets) {
    layout(p.hexes, app.collapsed, anchorsFor(p.id));
    rememberAnchors(p.id, p.hexes);
  }
  // Nach dem verankerten Layout pruefen, ob die Ordnung noch stimmt.
  app.maybeReorder();
  const first = app.planetId === null;
  const fromHash = location.hash.slice(1);
  app.planetId ??= app.state.planets.some((p) => p.id === fromHash)
    ? fromHash
    : app.state.planets[0]?.id;
  // Vor dem ersten Fit, nicht danach: `fitTarget()` misst das Band zwischen
  // HUD und Legende, und das HUD ist ohne Zaehler und Planetenknoepfe nur
  // 18 statt 45 px hoch. Andersherum rechnete der Ladefit mit einem 27 px zu
  // hohen Band und setzte die Kolonie ein paar Pixel zu tief.
  renderHud();
  // Nur beim ersten Laden zentrieren — spaeter wuerde jeder Refresh den
  // Blick zuruecksetzen, waehrend man gerade woanders hinscrollt.
  // Erst fitten, wenn das HUD seine endgueltige Hoehe hat: Shoelaces
  // sl-tooltip fuellt sein Shadow-DOM erst im Microtask, davor ist #counts
  // schmal und das HUD faelschlich einzeilig (45 statt 75 px bei 1500 px).
  // band() mass beim allerersten Fit diesen Zwischenstand — die Kolonie sass
  // 3,5 % zu gross und 12 px zu hoch. Ein Frame Wartezeit, kein Frame wird
  // davor gezeichnet (scheduleTick kommt erst am Ende von refresh).
  if (first) {
    await hudSettled();
    R.fitView();
  }
  // Auswahl an die neuen Daten binden, sonst zeigt das Panel alte Werte
  if (app.selected) {
    app.selected = planet()?.hexes.find((h) => h.id === app.selected.id) ?? null;
    if (app.selected) renderPanel(app.selected);
    else document.getElementById('panel').hidden = true;
  }
  // Offene Tages-Card an die neuen Zahlen binden, wie das Panel. Den Anker
  // liefert der aktive Renderer (2D: Weltpunkt, 3D: Bildschirmrechteck).
  if (app.dayHover) {
    const h = planet()?.hexes.find((x) => x.id === app.dayHover.hexId);
    const d = h?.commitsByDay?.some(Boolean) ? R.dayAnchor(h, app.dayHover.day) : null;
    if (d) showDayTip(d);
    else hideDayTip();
  }
  R.scheduleTick();
}

/* Zuklappen einer Familie: dieselbe Sequenz braucht der Chip auf der Karte
 * und der Knopf im Panel. Auf `app` registriert statt exportiert, weil
 * `store.mjs` selbst nichts importiert — ein Import aus panel.mjs zurueck
 * nach map.mjs/hexmap.mjs waere ein Zyklus. `location.reload()` war die
 * Abkuerzung aus Task 8s Entwurf, die diese Funktion ueberfluessig macht. */
app.toggleFamily = (id) => {
  toggleCollapsed(id);
  for (const p of app.state.planets) {
    layout(p.hexes, app.collapsed, anchorsFor(p.id));
    rememberAnchors(p.id, p.hexes);
  }
  // Wer ein Kind ausgewaehlt hatte, das jetzt verschwindet, soll kein
  // Panel zu einer unsichtbaren Wabe sehen. Bleibt die Auswahl sichtbar
  // (Container oder unbeteiligtes Feld), muss das Panel neu rendern — sonst
  // zeigt der Knopf nach dem eigenen Klick weiter die alte Beschriftung.
  if (app.selected?.hidden) {
    app.selected = null;
    document.getElementById('panel').hidden = true;
  } else if (app.selected) {
    renderPanel(app.selected);
  }
  // Zuklappen gibt Zellen frei, Aufklappen nimmt welche — der Knopf "ordnen"
  // haette danach meist etwas zu tun und soll das sofort zeigen, nicht erst
  // beim naechsten Poll.
  app.refreshHud?.();
  R.draw();
};

/* Sprung von einem Feld zu einem anderen (Panel: "Zum Parent springen").
 * Gleiches Muster wie `app.toggleFamily` und aus demselben Grund auf `app`
 * registriert statt aus panel.mjs exportiert: ein Import von panel.mjs zurueck
 * nach map.mjs/view.mjs waere ein Zyklus.
 *
 * Bewegt zusaetzlich die Kamera (`animateView`/`hexTarget`, dieselbe
 * Kurzstrecke wie beim Doppelklick auf eine Wabe) statt nur das Panel
 * umzuschalten: "springt hin" in der Spec ist woertlich gemeint, und ohne
 * Kamerabewegung muesste man den Parent auf der Karte erst wiederfinden --
 * bei einer grossen Familie ausserhalb des sichtbaren Ausschnitts sonst
 * spurlos. */
app.selectHex = (id) => {
  const h = planet()?.hexes.find((x) => x.id === id);
  if (!h || h.hidden) return;
  app.selected = h;
  app.markedAgent = null;
  renderPanel(h);
  R.focusHex(h);
};

/* Klick auf ein Feld oder ins Leere: auswaehlen und Panel zeigen, oder
 * abwaehlen und schliessen. Auf `app`, weil der 3D-Renderer seine
 * Zeiger-Events selbst haelt (OrbitControls sitzt auf seinem Canvas) und
 * dieselbe Folge braucht wie der 2D-pointerup unten. */
app.clickHex = (h) => {
  app.selected = h;
  // Ein Klick auf die Flaeche meint das Feld, nicht die Figur, die zuletzt
  // markiert war — sonst bliebe eine Hervorhebung stehen, die niemand mehr
  // gemeint hat.
  app.markedAgent = null;
  if (h) renderPanel(h);
  else document.getElementById('panel').hidden = true;
  R.draw();
};

/* Klick auf eine Figur: ihr Feld auswaehlen, Panel zeigen, die Zeile dieses
 * Agenten hervorheben. Auf `app`, damit beide Renderer dieselbe Folge
 * nehmen — 2D findet die Figur ueber die gemerkten Zeichenpositionen
 * (agents.mjs), 3D per Raycasting (r3d/pick.mjs).
 *
 * Die Kamera bleibt, wo sie ist: man hat die Figur ja gerade angesehen. */
app.clickAgent = (hit) => {
  const h = planet()?.hexes.find((x) => x.id === hit.hexId);
  if (!h || h.hidden) return false;
  app.selected = h;
  app.markedAgent = hit.key;
  renderPanel(h);
  R.draw();
  return true;
};

/* Umordnen: der sichtbare Planet vergisst seine Plaetze, legt sich einmal
 * nach Gewicht und merkt sich das Ergebnis. Nur der sichtbare — die anderen
 * Planeten ordnet man, wenn man sie ansieht. Sofort, ohne Schwelle und
 * Sperrfrist: das ist der Knopf. Die Ziele stehen danach fest, `app.move`
 * laesst hexCenter() bis dahin noch von den gemerkten Von-Positionen aus
 * interpolieren — die Fahrt selbst zeichnet map.mjs. */
app.reorder = () => {
  const p = planet();
  if (!p) return;
  // Von-Positionen merken, bevor das Layout die Ziele setzt. Nur sichtbare
  // Felder: was versteckt war und es bleibt, faehrt nicht. hexCenter() statt
  // hexToPixel(h.q, h.r): laeuft schon eine Fahrt, ist h.q/h.r bereits das
  // ALTE Ziel (layout() setzt sie sofort) — hexToPixel laese also wieder nur
  // das Ziel, nicht die gerade gezeichnete, interpolierte Position. Ein
  // zweiter Klick mitten in der Fahrt liesse das Feld dann springen, statt
  // dort weiterzufahren, wo es gerade steht.
  for (const h of p.hexes) {
    if (h.hidden) continue;
    const c = hexCenter(h);
    h.fromX = c.x;
    h.fromY = c.y;
  }
  forgetAnchors(p.id);
  layout(p.hexes, app.collapsed);
  rememberAnchors(p.id, p.hexes);
  app.lastReorderMs = Date.now();
  app.move = { t0: performance.now(), ms: app.state?.config?.reorder?.animateMs ?? 400 };
  if (app.selected) renderPanel(app.selected);
  app.refreshHud?.(); // der Knopf ist jetzt leer, das soll man sehen
  R.scheduleTick();
};

/* Automatisch: nur bei echter Fehlordnung und nur, wenn die letzte Umordnung
 * lange genug her ist. Kleinkram — ein Agent wechselt von "arbeitet" auf
 * "wartet", der Rang steigt um eins — bewegt damit nichts. */
app.maybeReorder = () => {
  const p = planet();
  const cfg = app.state?.config?.reorder;
  if (!p || !cfg) return false;
  if (Date.now() - app.lastReorderMs < cfg.cooldownSeconds * 1000) return false;
  if (!reorderNeeded(p.hexes, app.collapsed, cfg.ringDelta)) return false;
  app.reorder();
  return true;
};

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  cancelViewAnim(); // Hand am Bild schlaegt den laufenden Tween
  hideDayTip(); // der Anker wandert beim Pan mit, die Karte nicht
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    draw(performance.now());
    return;
  }
  // Der Chip ist ein Klickziel und soll sich so anfuehlen: Zeiger statt Hand,
  // und die Familie, die er betrifft, leuchtet auf (map.mjs).
  const chip = chipAt(e.clientX, e.clientY);
  const chipId = chip?.id ?? null;
  if (chipId !== app.chipHover) {
    app.chipHover = chipId;
    draw(performance.now());
  }
  // Zeiger ueber allem, was ein Klickziel ist. Die Figur gehoert seit dem
  // Agenten-Klick dazu; ohne den Zeiger sieht man ihr nicht an, dass sie
  // eines ist. Kein draw() dafuer — der Cursor ist CSS, kein Bildinhalt.
  canvas.style.cursor = chipId || agentAt(e.clientX, e.clientY) ? 'pointer' : '';
  const h = hexAt(e.clientX, e.clientY);
  if (h?.id !== app.hover?.id) {
    app.hover = h;
    draw(performance.now());
  }
  const d = dayAt(e.clientX, e.clientY);
  if (d?.hex.id !== app.dayHover?.hexId || d?.day !== app.dayHover?.day) {
    if (d) {
      app.dayHover = { hexId: d.hex.id, day: d.day };
      showDayTip(d);
    } else {
      hideDayTip();
    }
    draw(performance.now());
  }
});
canvas.addEventListener('pointerleave', () => {
  if (app.chipHover) {
    app.chipHover = null;
    canvas.style.cursor = '';
    draw(performance.now());
  }
  if (!app.dayHover) return;
  hideDayTip();
  draw(performance.now());
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  const wasDrag = drag?.moved;
  drag = null;
  if (wasDrag) return; // Pan darf nicht als Klick zaehlen
  // Der Chip schlaegt die Wabe: sonst waehlte jeder Klick auf ihn das Feld
  // aus, statt zu klappen.
  const chip = chipAt(e.clientX, e.clientY);
  if (chip) {
    app.toggleFamily(chip.id);
    return;
  }
  // Die Figur schlaegt die Wabe, wie der Chip: sie steht darauf, und wer sie
  // trifft, meint sie.
  const a = agentAt(e.clientX, e.clientY);
  if (a && app.clickAgent(a)) return;
  const h = hexAt(e.clientX, e.clientY);
  app.selected = h;
  app.markedAgent = null;
  if (h) renderPanel(h);
  else document.getElementById('panel').hidden = true;
  draw(performance.now());
});
/* Zoom um den Cursor, nicht um die Fenstermitte. Vorher wanderte ein Feld am
 * Rand beim Hineinzoomen aus dem Bild heraus — man musste abwechselnd zoomen
 * und ziehen, um irgendwo hinzukommen. Der Weltpunkt unter dem Cursor wird
 * *vor* der Zoom-Aenderung genommen und danach wieder unter den Cursor
 * geschoben; damit bleibt der Punkt, den man anvisiert, wo er ist. */
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    cancelViewAnim();
    hideDayTip(); // Anker in Bildschirmkoordinaten, nach dem Zoom stimmt er nicht mehr
    const w = toWorld(e.clientX, e.clientY);
    view.zoom = clampZoom(view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    // Umkehrung von screenX = innerWidth / 2 + view.x + world.x * zoom
    view.x = e.clientX - innerWidth / 2 - w.x * view.zoom;
    view.y = e.clientY - innerHeight / 2 - w.y * view.zoom;
    draw(performance.now());
  },
  { passive: false },
);

/* Doppelklick zoomt in eine Wabe, ins Leere zurueck auf die Uebersicht.
 *
 * Bewusst der Doppelklick und nicht der Einfachklick: der waehlt aus und
 * oeffnet das Panel, das muss er weiter tun. Ein Doppelklick loest deshalb
 * zusaetzlich zwei `pointerup`s aus — auf einer Wabe waehlt er sie zweimal
 * aus (folgenlos), ins Leere schliesst der erste das Panel und danach faehrt
 * die Uebersicht an. Das ist gewollt: die Alternative waere ein Timer, der
 * bei jedem Einfachklick erst 250 ms wartet, ob noch ein zweiter kommt — die
 * Auswahl wuerde bei jedem Klick traege. Wer das hier "repariert", macht den
 * haeufigen Fall langsam, um den seltenen sauber zu bekommen.
 *
 * `hexAt()` trifft nur Projektfelder, nicht den Hangar — ein Doppelklick auf
 * die Station zaehlt darum als "ins Leere" und fuehrt zur Uebersicht. */
canvas.addEventListener('dblclick', (e) => {
  const h = hexAt(e.clientX, e.clientY);
  animateView(h ? hexTarget(h) : fitTarget());
});

document.getElementById('close').onclick = () => {
  document.getElementById('panel').hidden = true;
  app.selected = null;
  R.draw();
};

/* Die Uhr laeuft unabhaengig vom Poll — sonst stuende oben nicht die Uhrzeit,
 * sondern der Zeitpunkt der letzten Erhebung. Auf die Sekundengrenze
 * ausgerichtet, damit die Anzeige nicht um bis zu einer Sekunde nachhinkt. */
const nowEl = document.getElementById('now');
function clock() {
  nowEl.textContent = new Date().toLocaleTimeString('de-DE');
  setTimeout(clock, 1000 - (Date.now() % 1000));
}
clock();

addEventListener('resize', () => R.resize());
// Der gemerkte Renderer wird aktiv, bevor irgendetwas zeichnet oder misst.
await R.initRenderer();
R.resize();

// Das HUD darf umbrechen (colony.css), seine Hoehe ist damit variabel. Das
// Panel steht per CSS darunter und kann eine Geschwisterhoehe nicht selbst
// lesen — deshalb hier gemessen und als --hud-h gesetzt. Ein ResizeObserver
// statt des resize-Events, weil die Hoehe auch ohne Fensteraenderung springt:
// wenn ein Zaehler breiter wird oder die Planetenknoepfe erst nach dem
// ersten State erscheinen.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--hud-h', `${entry.target.offsetHeight}px`);
}).observe(document.getElementById('hud'));
loadAnchors();
loadCollapsed();
await refresh();
/* Intervall aus der Config des Servers statt einer Konstante hier. Der erste
 * Refresh ist an dieser Stelle durch, der Wert steht also fest. Eine
 * Config-Aenderung wirkt erst nach einem Reload — das reicht. */
setInterval(refresh, (app.state?.config?.pollSeconds ?? 3) * 1000);
