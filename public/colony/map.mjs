/* Die Karte zeichnen und die Kamera bewegen: ein Frame, die tick-Kette, die
 * Tweens. Das Modul, das alle Zeichen-Module zusammenfuehrt. */

import { BUBBLE_STATES, drawAgents, resetAgentHits } from './agents.mjs';
import { anchorsFor } from './anchors.mjs';
import { CHIP_DX, CHIP_DY, CHIP_R } from './collapse.mjs';
import { hexPath, hexToPixel } from './hex.mjs';
import { DIRS, aggregateGit, cellsOf, descendantsOf, dryLayout, index, rootOf } from './hexmap.mjs';
import { drawSkyline } from './skyline.mjs';
import { COLORS, FILL, HEX, app, canvas, ctx, frameGap, planet, view } from './store.mjs';
import { drawLabel, drawStatus } from './text.mjs';
// Als Namensraum, nicht als `t`: in diesem Modul heisst die Animationszeit
// `t` (draw(t), tick(t)) und wuerde den Import in jeder Zeichenfunktion
// verdecken — `t is not a function` beim ersten Frame.
import * as i18n from './i18n.mjs';
import { cellCenter, fitTarget, hexCenter } from './view.mjs';

/* Laufender Tween. Jeder Start erhoeht den Token; ein Frame mit veraltetem
 * Token laesst seine Kette einfach fallen. Direkte Eingabe (Ziehen, Mausrad)
 * erhoeht ihn ebenfalls — wer selbst am Bild dreht, soll nicht gegen eine
 * nachlaufende Animation arbeiten. Steht vor jedem Schreiber von `view`,
 * damit keiner ihn uebersehen kann. */
let viewAnim = 0;
const cancelViewAnim = () => viewAnim++;

/* Die Figuren, die fuer ein Feld tatsaechlich gezeichnet werden.
 *
 * Bei einem zugeklappten Container rollen die Nachkommen mit hoch, statt mit
 * ihnen von der Karte zu verschwinden — der Git-Rand wird beim Zuklappen
 * aggregiert, und eine wartende Figur darf nicht weniger sichtbar sein als
 * ein dirty Rand. Ein verstecktes Feld liefert selbst nichts.
 *
 * `draw()` und `tick()` muessen dieselbe Menge sehen, sonst pulsiert die
 * Animationskette fuer Figuren, die niemand sieht. `idx` kommt vom Aufrufer:
 * einmal je `draw()` gebaut, nicht je Feld — in einem animierten Frame baut
 * `tick()` sich fuer die Pulspruefung noch ein zweites Mal einen eigenen
 * (Backlog: die beiden Aufrufe zusammenlegen). */
/* Figuren zeigt die Karte nur fuer Sessions mit lebendem Prozess (Andrés
 * Wunsch vom 2026-09-14: "es sollten nicht so viele Agenten einfach so auf
 * den Feldern sitzen" — an dem Tag standen 40 Figuren auf der Karte, sechs
 * davon gehoerten zu einem offenen Fenster). Das Panel listet weiter alle
 * erhobenen Agenten mit "offen"/"beendet"; die Karte ist der Blick auf das,
 * was gerade laeuft.
 *
 * `!== false`, nicht `=== true`: `open` ist null, wenn die Prozess-Registry
 * (~/.claude/sessions) nicht lesbar war. Bei einem Ausfall dort soll die
 * Karte nicht lautlos leer werden — sie zeigt dann lieber zu viel als
 * nichts. */
const live = (agents) => agents.filter((a) => a.open !== false);

function drawnAgentsOf(h, idx) {
  if (h.hidden) return [];
  if (!app.collapsed.has(h.id)) return live(h.agents);
  return live([...h.agents, ...descendantsOf(h.id, idx).flatMap((k) => k.agents)]);
}

/* Kantenstuecke zu Linienzuegen verketten.
 *
 * Jede Silhouetten-Kante fuer sich gestrichen, traf an einer gemeinsamen
 * Ecke der Rundkappenstift zweier Strecken aufeinander — ein kleiner Punkt
 * je Ecke. Aufeinanderfolgende Kanten teilen sich exakt einen Endpunkt (die
 * Geometrie kommt aus Mittelpunkt und Senkrechter, bis auf Rundung
 * identisch); daraus entstehen geschlossene Zuege, die als EIN Pfad mit
 * lineJoin gestrichen werden. Schluessel auf halbe Pixel gerundet. */
function stitch(segments) {
  const key = (p) => Math.round(p.x * 2) + ',' + Math.round(p.y * 2);
  const at = new Map();
  segments.forEach((s, i) => {
    for (const end of ['a', 'b']) {
      const k = key(s[end]);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push({ i, end });
    }
  });
  const used = new Set();
  const paths = [];
  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const pts = [segments[i].a, segments[i].b];
    let cur = segments[i].b;
    let closed = false;
    for (;;) {
      const next = (at.get(key(cur)) ?? []).find((e) => !used.has(e.i));
      if (!next) break;
      used.add(next.i);
      const s = segments[next.i];
      cur = next.end === 'a' ? s.b : s.a;
      if (key(cur) === key(pts[0])) { closed = true; break; }
      pts.push(cur);
    }
    paths.push({ pts, closed });
  }
  return paths;
}

function fitView() {
  // Erst den laufenden Tween abbrechen, dann setzen. Ohne das ueberschreibt
  // eine noch laufende Doppelklick-Bewegung die frisch gesetzte Ansicht im
  // naechsten Frame und rastet am Ende exakt auf ihr altes Ziel ein — beim
  // Planetenwechsel mitten im Tween stuende der neue Planet dann auf Zoom und
  // Versatz einer Wabe des alten.
  cancelViewAnim();
  const target = fitTarget();
  if (!target) return;
  view.x = target.x;
  view.y = target.y;
  view.zoom = target.zoom;
}

/* Kurzer Weg von der aktuellen Ansicht zum Ziel, statt hart umzuschalten.
 * Zweck ist Orientierung, nicht Dekoration: bei einem Sprung muss man nach
 * jedem Doppelklick neu suchen, wo man gelandet ist; die 250 ms zeigen die
 * Bewegung, ohne dass man auf sie wartet. Ease-out, weil das Ankommen die
 * Information ist — losfahren darf es schnell. */
function animateView(target, ms = 250) {
  if (!target) return;
  cancelViewAnim();
  const token = viewAnim;
  const from = { x: view.x, y: view.y, zoom: view.zoom };
  const t0 = performance.now();

  function step(now) {
    if (token !== viewAnim) return; // abgeloest
    const t = Math.min(1, (now - t0) / ms);
    if (t >= 1) {
      // Letzter Frame exakt auf das Ziel, nicht auf 0.9999 davon — sonst
      // bliebe nach jedem Tween ein Rundungsrest im View stehen.
      view.x = target.x;
      view.y = target.y;
      view.zoom = target.zoom;
    } else {
      const k = 1 - (1 - t) ** 3;
      view.x = from.x + (target.x - from.x) * k;
      view.y = from.y + (target.y - from.y) * k;
      view.zoom = from.zoom + (target.zoom - from.zoom) * k;
    }
    draw(now);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* Volle Pixeldichte des Bildschirms, bewusst ohne Grenze: mit 1,5 statt 2,5
 * am internen Display war die Canvas-Schrift deutlich verschwommen (Andrés
 * Urteil am 2026-09-16, Bild fundus/referenzen/2026-09-16-pixeldichte-2d-
 * 25-vs-15.png). 3D deckelt dagegen (scene.mjs, Config maxPixelRatio3d). */
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(performance.now());
}

/* Ecke k eines Sechsecks um (cx, cy), Radius r -- dieselbe Ecklage wie
 * hexPath() und wie insideHex() in 3D. */
function corner(cx, cy, r, k) {
  const a = (Math.PI / 3) * k;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/* Zelle -> Feld, fuer sichtbare Felder. Mehrfach-Waben (hexmap.mjs::sizeOf)
 * machen aus der alten Suche nach h.q/h.r eine Suche ueber alle Zellen. */
function cellIndex(hexes) {
  const m = new Map();
  for (const h of hexes) {
    if (h.hidden) continue;
    for (const c of cellsOf(h)) m.set(c.q + ',' + c.r, h);
  }
  return m;
}

function draw(t = 0) {
  const p = planet();
  const idx = p ? index(p.hexes) : null;
  // Familie unter dem Chip (Task 8): ihre Mitglieder leuchten, und wenn sie
  // zugeklappt ist, zeigt ein Geist, wo die Kinder wieder auftauchen wuerden
  // — Trockenlauf mit Ankern und genau dieser Familie aufgeklappt, also das
  // Layout, das der Klick erzeugen wuerde.
  const hotRoot = app.chipHover && p ? p.hexes.find((h) => h.id === app.chipHover) : null;
  const hotFamily = hotRoot ? new Set([hotRoot.id, ...descendantsOf(hotRoot.id, idx).map((k) => k.id)]) : new Set();
  let ghostCells = [];
  if (hotRoot && app.collapsed.has(hotRoot.id)) {
    const opened = new Set([...app.collapsed].filter((id) => id !== hotRoot.id));
    const dry = dryLayout(p.hexes, opened, anchorsFor(p.id));
    ghostCells = descendantsOf(hotRoot.id, idx).map((k) => dry.get(k.id)).filter((c) => c && !c.hidden);
  }
  // Die Trefferliste der Figuren gilt fuer genau diesen Frame (agents.mjs).
  resetAgentHits();
  ctx.save();
  ctx.fillStyle = p ? (COLORS.planet[p.theme] ?? '#0d1117') : '#0d1117';
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  if (!p) {
    ctx.restore();
    return;
  }

  ctx.translate(innerWidth / 2 + view.x, innerHeight / 2 + view.y);
  ctx.scale(view.zoom, view.zoom);

  // Space Station / Hangar in der Mitte
  const s = hexToPixel(p.station.q, p.station.r);
  hexPath(s.x, s.y, HEX * FILL);
  ctx.fillStyle = '#1b2430';
  ctx.fill();
  ctx.strokeStyle = '#8b949e';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);

  // Gleiches Layout wie ein Projektfeld: Titel auf Platte oben, Zaehler
  // unten. Vorher sassen "Hangar"/"N ohne Projekt" in der Mitte - genau da,
  // wo drawAgents() den Kopf-Punkt zeichnet. Der Punkt lag auf der Ziffer,
  // "4 ohne Projekt" liess sich als "0 ohne Projekt" lesen.
  drawLabel(s.x, s.y, i18n.t('map.station'), '#8b949e');
  // Auch hier nur laufende Sessions (live()): die Zahl beschreibt die
  // Figuren darunter, nicht die Erhebung.
  const strays = live(p.station.agents);
  drawStatus(s.x, s.y, i18n.t('map.strays', { n: strays.length }), 'rgba(230,237,243,.75)');
  drawAgents(s.x, s.y, strays, t);

  /* Silhouette und Bruecken zuerst: sie liegen unter den Waben. Farbe ist auf
   * dieser Karte doppelt vergeben (Fuellung = Aktivitaet, Rand = Git) — der
   * schmale Spalt zwischen zwei Waben (Fuellradius HEX*0.96, Feld-zu-Feld-
   * Abstand entspricht HEX) ist die einzige Flaeche, die dafuer noch frei
   * ist. Ein Wash pro Feld (Fixrunde 0) faerbte dort jede Kante gleich ein —
   * an einer echten Familiengrenze war das von einer Innenkante nicht zu
   * unterscheiden, zwei benachbarte Familien liefen ineinander. Jetzt nur
   * noch der Aussenrand: fuer jedes sichtbare Familienmitglied und jede der
   * sechs Nachbarzellen wird genau dann eine Strecke in den Spalt gelegt,
   * wenn dort KEIN sichtbares Mitglied derselben Familie sitzt. Innenkanten
   * bleiben leer, die Flaeche liest sich als eine Form; zwei angrenzende
   * Familien bekommen zwei getrennte Umrisse statt eines gemeinsamen Wasch.
   * Die Strecke selbst kommt ohne Vertex-Tabelle aus: Mittelpunkt zwischen
   * den beiden Zentren liegt auf der gemeinsamen Kante, die Senkrechte dazu
   * ist die Kantenrichtung. */
  // Waehrend der Fahrt keine Silhouette: ihre Kanten kommen aus der
  // Rasternachbarschaft, die schon die Zielwerte hat, waehrend die Zentren
  // noch unterwegs sind — der Umriss liefe als Gummiband durchs Bild.
  if (!app.move) {
    const familyId = (h) => rootOf(h, idx).id;
    const familiesWithVisibleChild = new Set(
      p.hexes.filter((h) => h.parentId && !h.hidden).map((h) => familyId(h)),
    );
    // Erst alle Kantenstuecke je Familie sammeln, dann verkettet streichen.
    const segsByFamily = new Map();
    const byCell = cellIndex(p.hexes);
    for (const h of p.hexes) {
      const fid = familyId(h);
      if (h.hidden || !familiesWithVisibleChild.has(fid)) continue;
      for (const cell of cellsOf(h)) {
      const c = hexToPixel(cell.q, cell.r);
      for (const [dq, dr] of DIRS) {
        const nq = cell.q + dq;
        const nr = cell.r + dr;
        const neighbour = byCell.get(nq + ',' + nr);
        if (neighbour && familyId(neighbour) === fid) continue; // Innenkante
        const n = hexToPixel(nq, nr);
        const mx = (c.x + n.x) / 2;
        const my = (c.y + n.y) / 2;
        const dx = n.x - c.x;
        const dy = n.y - c.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len;
        const py = dx / len;
        const half = HEX / 2;
        if (!segsByFamily.has(fid)) segsByFamily.set(fid, []);
        segsByFamily.get(fid).push({
          a: { x: mx - px * half, y: my - py * half },
          b: { x: mx + px * half, y: my + py * half },
        });
      }
      }
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [fid, segs] of segsByFamily) {
      const hot = hotFamily.has(fid);
      ctx.strokeStyle = hot ? COLORS.family.outlineHot : COLORS.family.outline;
      ctx.lineWidth = hot ? 8 : 6;
      for (const { pts, closed } of stitch(segs)) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        if (closed) ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
  }

  ctx.strokeStyle = COLORS.family.bridge;
  ctx.lineWidth = 9;
  for (const h of p.hexes) {
    if (h.hidden || !h.parentId) continue;
    const par = p.hexes.find((x) => x.id === h.parentId);
    if (!par || par.hidden) continue;
    const a = hexCenter(par, t);
    const b = hexCenter(h, t);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // Geister-Umriss: gestrichelte Waben an den Zellen, die der Klick fuellt.
  if (ghostCells.length) {
    ctx.strokeStyle = COLORS.family.ghost;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    for (const g of ghostCells) {
      const c = hexToPixel(g.q, g.r);
      hexPath(c.x, c.y, HEX * 0.9);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  for (const h of p.hexes) {
    if (h.hidden) continue;
    const c = hexCenter(h, t);

    const cells = cellsOf(h);
    const mine = new Set(cells.map((x) => x.q + ',' + x.r));
    const R = HEX * FILL;
    // `state: null` heisst: dieses Feld hat kein eigenes Transkript, aus dem
    // sich eine Aktivitaet ablesen liesse. Nicht "hier hat nie ein Agent
    // gearbeitet" — eine Figur kann sehr wohl hier stehen, wenn eine Session
    // per cd in dieses Unter-Repo gewandert ist (sessions.mjs haengt sie dann
    // familienintern um). Eine Aktivitaetsfarbe waere also geraten, darum
    // eine neutrale Flaeche.
    ctx.fillStyle = COLORS.state[h.state] ?? COLORS.empty;
    for (const cell of cells) {
      const cc = cellCenter(h, cell, t);
      hexPath(cc.x, cc.y, R);
      ctx.fill();
    }
    /* Ein Projekt kann mehrere Waben belegen. Zwischen zwei eigenen Zellen
     * darf kein Spalt stehen, sonst liest sich der Klumpen als mehrere
     * Felder -- also wird die Fuge zugelegt: das Viereck zwischen der Kante
     * der einen und der Gegenkante der anderen Zelle. Nach aussen bleibt der
     * Spalt, dort traegt er die Familien-Silhouette. */
    if (cells.length > 1) {
      for (const cell of cells) {
        const cc = cellCenter(h, cell, t);
        for (let k = 0; k < 6; k++) {
          const d = DIRS[(6 - k) % 6];
          const nk = cell.q + d[0] + ',' + (cell.r + d[1]);
          if (!mine.has(nk)) continue;
          const nc = cellCenter(h, { q: cell.q + d[0], r: cell.r + d[1] }, t);
          const a = corner(cc.x, cc.y, R, k);
          const b = corner(cc.x, cc.y, R, k + 1);
          const cB = corner(nc.x, nc.y, R, k + 3);
          const dB = corner(nc.x, nc.y, R, k + 4);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(cB.x, cB.y);
          ctx.lineTo(dB.x, dB.y);
          ctx.closePath();
          ctx.fill();
          /* Wo drei eigene Zellen zusammenstossen, bleibt zwischen den drei
           * Fugen noch ein Dreieck offen. Seine Ecken sind dieselbe
           * Wabenecke, von den drei Zellen aus gesehen: e an dieser, e+2 am
           * Nachbarn ueber Kante k, e+4 am Nachbarn ueber Kante k+1. */
          const d2 = DIRS[(6 - ((k + 1) % 6)) % 6];
          const n2k = cell.q + d2[0] + ',' + (cell.r + d2[1]);
          if (!mine.has(n2k)) continue;
          const n2 = cellCenter(h, { q: cell.q + d2[0], r: cell.r + d2[1] }, t);
          const e = k + 1;
          const p0 = corner(cc.x, cc.y, R, e);
          const p1 = corner(nc.x, nc.y, R, e + 2);
          const p2 = corner(n2.x, n2.y, R, e + 4);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Stale sichtbar "zuwachsen" lassen — Punktraster statt Klartext
    if (h.state === 'stale') {
      // Raster nur auf der Hauptwabe: hexPath() ruft selbst beginPath(), ein
      // Sammelpfad ueber alle Zellen ginge so nicht -- und ein stale-Feld hat
      // nach Definition wenig Arbeit, also fast immer nur eine Wabe.
      ctx.save();
      hexPath(c.x, c.y, R);
      ctx.clip();
      ctx.fillStyle = 'rgba(154,184,96,.22)';
      for (let i = 0; i < 26; i++) {
        const a = (i * 2.399) % (Math.PI * 2);
        const d = HEX * 0.92 * Math.sqrt((i + 1) / 27);
        ctx.beginPath();
        ctx.arc(c.x + d * Math.cos(a), c.y + d * Math.sin(a), 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Kein Repo -> gestrichelt. Das ist kein Zustand, den man aufraeumen
    // kann, also soll er auch nicht wie eine Warnung aussehen.
    // Zugeklappt nimmt der Container den Git-Zustand seiner Kinder auf —
    // sonst versteckte das Zuklappen genau den Status, wofuer es die
    // Satelliten gibt. Aufgeklappt bleibt er bei seinem eigenen.
    const kids = h.satellites ? descendantsOf(h.id, idx) : [];
    const shown = app.collapsed.has(h.id) ? aggregateGit(h, kids) : h.gitState;
    if (shown === 'norepo') ctx.setLineDash([6, 5]);
    ctx.strokeStyle = COLORS.git[shown] ?? '#6f7785';
    const hot = hotFamily.has(h.id);
    ctx.lineWidth = app.selected?.id === h.id ? 5 : app.hover?.id === h.id || hot ? 4 : 2.5;
    /* Nur die Aussenkanten des Klumpens: eine Innenkante wuerde vier Waben
     * eines Projekts wie vier Projekte aussehen lassen. Kante k liegt in
     * Richtung DIRS[(6 - k) % 6] -- dieselbe Zuordnung wie in tiles.mjs. */
    ctx.beginPath();
    for (const cell of cells) {
      const cc = cellCenter(h, cell, t);
      for (let k = 0; k < 6; k++) {
        const d = DIRS[(6 - k) % 6];
        if (mine.has(cell.q + d[0] + ',' + (cell.r + d[1]))) continue;
        const a = corner(cc.x, cc.y, R, k);
        const b = corner(cc.x, cc.y, R, k + 1);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Gebaeudedichte = Commits je Kalendertag (drawSkyline). Skyline oben, zwischen
    // Hex-Kante (-0.83 HEX bei Radius 0.96) und Oberkante der Label-Platte
    // (-0.47 HEX): das einzige Band, das keine der beiden Agenten-Anordnungen
    // beruehrt. In der Mitte (Fuss bei +22 px) standen die Balken genau unter
    // der Cluster-Reihe (Koepfe +9, Kinder +22) und unter den mittleren
    // Punkten der zweiten Bogenreihe; unten zwischen Statuszeile und Kante
    // blieben nur 16 px. Fuss bei -0.55 HEX: 7 px Luft zur Platte, knapp
    // 10 px zur Kante, der hoechste Balken (14 px) eingerechnet.
    drawSkyline(c.x, c.y, h);

    // Label innerhalb des Hex mit dunkler Platte. Auf der Kante gezeichnet
    // wandert es sonst optisch ins Nachbarfeld und wird dort abgeschnitten.
    drawLabel(c.x, c.y, h.title, '#e6edf3');

    // Sessions und letzte Aktivitaet: die zwei Zahlen, die das Feld einordnen.
    // `state: null` heisst nur "kein Transkript" -- eine Aussage ueber das
    // Feld, nicht darueber, ob dort gerade jemand steht. Sessions.mjs haengt
    // Figuren bewusst in Satelliten derselben Familie um, sobald eine
    // Session wirklich dort arbeitet (Task 3); "kein Agent hier" waere dann
    // falsch statt nur unvollstaendig -- eine pulsierende Sprechblase direkt
    // ueber dem Text, der das Gegenteil behauptet. Frueher stand hier genau
    // das (Final-Review-Fund 1). "kein eigenes Transkript" war die erste
    // Korrektur, ragte aber bei 10px in den Nachbarn -- ueber `drawStatus()`
    // geklemmt (Final-Review-Fund 2), darum die kuerzere Formulierung ohne
    // "eigenes": das Wort war fuer die Aussage nicht noetig, "kein Repo" im
    // Rand-Rand steht genauso ohne "eigenes" da.
    drawStatus(
      c.x,
      c.y,
      h.state === null
        ? i18n.t('map.noTranscript')
        : i18n.t('map.hexStatus', { sessions: h.sessions.total, days: h.daysSinceActivity }),
      'rgba(230,237,243,.75)',
    );

    // Der Chip: Zahl der Kinder, Vorzeichen sagt die Richtung.
    if (h.satellites) {
      const open = !app.collapsed.has(h.id);
      ctx.beginPath();
      ctx.arc(c.x + CHIP_DX, c.y + CHIP_DY, app.chipHover === h.id ? CHIP_R + 2 : CHIP_R, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(13,17,23,.85)';
      ctx.fill();
      ctx.strokeStyle = COLORS.family.bridge;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = COLORS.family.bridge;
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      // Der Chip zaehlt, was er versteckt: alle Nachkommen, nicht nur die direkten Kinder.
      ctx.fillText((open ? '−' : '+') + kids.length, c.x + CHIP_DX, c.y + CHIP_DY + 4);
      ctx.lineWidth = 1;
    }

    drawAgents(c.x, c.y, drawnAgentsOf(h, idx), t, h);
  }
  ctx.restore();
}

let tickQueued = false;
let lastTick = -Infinity; // Zeitstempel des letzten gezeichneten Animations-Frames

/* Genau eine tick-Kette. Ohne den Guard startete jeder Poll und jeder
 * Planetenklick eine weitere, und waehrend etwas pulsiert liefen sie alle
 * parallel weiter — ein zusaetzlicher draw() pro Frame pro Poll. */
function scheduleTick() {
  if (tickQueued) return;
  tickQueued = true;
  requestAnimationFrame(tick);
}

/* Nur animieren, wenn tatsaechlich etwas pulsiert — sonst ein Frame und Ruhe.
 * Ueber `drawnAgentsOf()`, nicht ueber `h.agents` roh: eine wartende Figur in
 * einer zugeklappten Familie ist in den Rohdaten immer noch da, gezeichnet
 * wird sie nur noch beim Container (oder gar nicht, wenn ihr Feld versteckt
 * ist). Pulsieren darf nur ausloesen, was auch zu sehen ist. */
function tick(t) {
  tickQueued = false;
  // Versteckt (3D aktiv): kein Frame und keine neue Kette. Sonst liefe die
  // Pulsschleife unsichtbar weiter, solange irgendwo ein Agent wartet.
  if (canvas.hidden) return;
  // Config maxFps: zu frueh fuer den naechsten Animations-Frame, also einen
  // Bildschirm-Frame auslassen. Nur diese Kette wird gedrosselt; Pan, Zoom
  // und animateView zeichnen ueber draw() direkt und bleiben fluessig.
  if (t - lastTick < frameGap()) {
    scheduleTick();
    return;
  }
  lastTick = t;
  // Die Fahrt endet, wenn ihre Zeit um ist: Von-Positionen abraeumen, damit
  // der naechste Frame ohne Interpolation zeichnet.
  const m = app.move;
  const moving = m && t - m.t0 < m.ms;
  if (m && !moving) {
    app.move = null;
    for (const pl of app.state?.planets ?? []) for (const h of pl.hexes) { delete h.fromX; delete h.fromY; }
  }
  const p = planet();
  const idx = p ? index(p.hexes) : null;
  const pulsing =
    p &&
    [
      ...p.hexes.flatMap((h) => drawnAgentsOf(h, idx)),
      ...live(p.station.agents),
    ].some((a) => BUBBLE_STATES.has(a.state));
  draw(t);
  if (pulsing || moving) scheduleTick();
}

export { animateView, cancelViewAnim, draw, fitView, resize, scheduleTick };
