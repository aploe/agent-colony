/* Die Figuren auf einem Feld: Gruppierung Hauptsession + Subagenten,
 * Punkte, Sprechblasen, Anordnung und Deckel. Der laengste Block der alten
 * Datei und der mit den meisten hart erarbeiteten Abstandsregeln. */

import { COLORS, HEX, ctx, view } from './store.mjs';
import { toWorld } from './view.mjs';

/* Wo in diesem Frame welche Figur steht. Nachgerechnet wird nichts: die
 * Anordnung unten ist zu verwinkelt (Bogen oder Cluster-Reihe, Deckel, Pitch
 * aus der Kinderbreite), eine zweite Kopie davon liefe binnen einer Woche
 * auseinander — wie `dayAt()` es fuer die viel einfachere Skyline-Geometrie
 * noch vertretbar tut. Stattdessen merkt sich `drawAgents` beim Zeichnen,
 * wohin es zeichnet, und `map.mjs` leert die Liste zu Beginn jedes Frames.
 *
 * Figuren im Hangar bleiben aussen vor: sie gehoeren zu keinem Feld, also
 * gibt es auch kein Panel, das ein Klick oeffnen koennte. */
let hits = [];
const resetAgentHits = () => { hits = []; };
const agentHits = () => hits; // fuer Szenarien und die Fehlersuche

/* Die Figur unter dem Zeiger, oder null. Die Toleranz ist in
 * Bildschirmpixeln gedacht, deshalb durch den Zoom geteilt — sonst waere ein
 * Punkt in der herausgezoomten Uebersicht kaum zu treffen. Bei mehreren
 * Kandidaten gewinnt der naechste, nicht der erste: Kind und Kopf stehen
 * dicht beieinander. */
function agentAt(sx, sy) {
  const w = toWorld(sx, sy);
  const tol = 5 / (view.zoom || 1);
  let best = null;
  for (const h of hits) {
    const d = Math.hypot(w.x - h.x, w.y - h.y);
    if (d > h.r + tol) continue;
    if (!best || d < best.d) best = { ...h, d };
  }
  return best;
}

/* Agenten zu Gruppen buendeln: eine Hauptsession und die Subagenten, die sie
 * gestartet hat. Der Parent steckt im Verzeichnisnamen des Transkripts, nicht
 * im Transkript selbst — `parentKey` kommt fertig aus sessions.mjs.
 *
 * Kinder ohne sichtbaren Kopf bleiben eine eigene Gruppe: der Parent kann
 * ausserhalb des Zeitfensters liegen oder auf einem anderen Feld arbeiten.
 * Sie unter den Tisch fallen zu lassen oder als Hauptsession auszugeben waere
 * beides gelogen. */
function groupAgents(agents) {
  const byKey = new Map(agents.filter((a) => !a.sub).map((p) => [p.key, { head: p, kids: [] }]));
  const orphans = new Map();

  for (const a of agents) {
    if (!a.sub) continue;
    const g = byKey.get(a.parentKey);
    if (g) {
      g.kids.push(a);
      continue;
    }
    const k = a.parentKey ?? '?';
    if (!orphans.has(k)) orphans.set(k, { head: null, kids: [] });
    orphans.get(k).kids.push(a);
  }
  return [...byKey.values(), ...orphans.values()];
}

function drawAgentDot(a, x, y, radius) {
  // Blass = ueber die Pfadkodierung des Scratchpads zugeordnet, nicht ueber
  // einen echten cwd. Die Zuordnung stimmt meistens, aber nicht sicher.
  ctx.globalAlpha = a.scratchpad ? 0.62 : 1;
  ctx.fillStyle = COLORS.agent[a.state];
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

const BUBBLE_STATES = new Set(['waiting', 'prompt']);

/* Pulsierende Sprechblase: die einzige Stelle, die Aufmerksamkeit fordert.
 * Gelb leer = Turn beendet, ich bin dran. Orange mit "!" = ein Tool-Aufruf
 * wartet auf eine Antwort (Permission, Frage, Plan-Freigabe) — der Glyph,
 * damit beides auch ohne Farbsehen auseinanderzuhalten ist.
 *
 * Fuer Kinderpunkte kleiner und *unter* dem Punkt: oberhalb sitzt der Kopf
 * der Hauptsession, da waere die Blase mitten im Stiel-Cluster. */
function drawBubble(x, y, t, seed, kind = 'waiting', small = false) {
  const s = small ? 0.7 : 1;
  const dir = small ? -1 : 1;
  const top = dir === 1 ? y - 20 * s : y + 10 * s;
  const base = dir === 1 ? y - 10 * s : y + 10 * s;
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t / 380 + seed);
  ctx.fillStyle = COLORS.agent[kind];
  ctx.beginPath();
  ctx.roundRect(x - 6 * s, top, 12 * s, 10 * s, 3 * s);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 2 * s, base);
  ctx.lineTo(x + 2 * s, base);
  ctx.lineTo(x, base + dir * 4 * s);
  ctx.fill();
  if (kind === 'prompt') {
    ctx.fillStyle = '#0d1117';
    ctx.font = '800 ' + (9 * s).toFixed(1) + 'px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', x, top + 5 * s + 0.5);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.globalAlpha = 1;
}

/* Der Platz, den die Figuren auf einer Wabe brauchen: Heimplaetze plus
 * Figurenbreite, lokal um die Feldmitte (x zur Seite, z nach Sueden).
 * Beide Renderer ordnen danach an, und builds.mjs haelt seine Bauplaetze
 * davon frei -- vorher stand die Haelfte der Module dort, wo Agenten
 * auftauchen (Andrés Befund vom 2026-09-14). Wer die Anordnung unten
 * aendert, aendert diese Zahlen mit, sonst luegt die Zone. */
const AGENT_ZONE = { halfX: 36, z0: 2, z1: 33 };
const SPREAD = HEX * 0.7;   // Breite der Clusterreihe (Koepfe mit Kindern)
const ARC_R = HEX * 0.36;   // Bogenradius der aeusseren Reihe ohne Kinder
const ARC_R2 = HEX * 0.19;  // zweite Reihe ab dem siebten Punkt

const KID_DROP = 13;   // Abstand Kopf -> Kinderreihe
const KID_GAP = 7;     // Abstand zwischen zwei Kinderpunkten

const STATE_RANK = { prompt: 0, working: 1, waiting: 2, idle: 3 };

/* Wer zuerst gezeigt wird, wenn der Platz nicht fuer alle reicht: Gruppen mit
 * Kindern, dann fragende vor arbeitenden vor wartenden vor idlen, dann die
 * juengste. */
function byInterest(a, b) {
  const head = (g) => g.head ?? g.kids[0];
  return (
    (b.kids.length ? 1 : 0) - (a.kids.length ? 1 : 0) ||
    STATE_RANK[head(a).state] - STATE_RANK[head(b).state] ||
    head(a).ageMinutes - head(b).ageMinutes
  );
}

function drawAgents(cx, cy, agents, t, hex = null) {
  const mark = (a, x, y, r) => { if (hex) hits.push({ key: a.key, hexId: hex.id, x, y, r }); };
  const all = groupAgents(agents);
  const hasKids = all.some((g) => g.kids.length);
  if (hasKids) all.sort(byInterest);

  /* Zwei Anordnungen, weil ein Stiel-Cluster viermal so breit ist wie ein
   * einzelner Punkt. Ohne Kinder bleibt es exakt beim alten Bogen (zwei
   * Reihen, bis zwoelf Punkte). Mit Kindern wird daraus eine flache Reihe aus
   * hoechstens fuenf Clustern — mehr Cluster nebeneinander verschmieren auf
   * der Hex-Breite zu einer Raupe, in der man gar nichts mehr erkennt. Was
   * nicht mehr reinpasst, steht als "+N" daneben statt zu verschwinden. */
  const groups = all.slice(0, hasKids ? 5 : 12);
  const rest = all.length - groups.length;
  const kidCap = groups.length > 2 ? 3 : 6;
  // Kopfabstand aus der Breite einer vollen Kinderreihe: (kidCap-1) Luecken
  // a KID_GAP plus aussen je 4.2 (Sprechblasen-Halbbreite eines Kindes im
  // prompt-Zustand, die reicht weiter als der Punkt), plus 6 px Luft
  // zwischen zwei Reihen. Mit festen 30 px lagen bei zwei Clustern mit je
  // sechs Kindern die inneren Kinder aufeinander (Reihe 43 px breit, Koepfe
  // nur 30 px auseinander). Bei drei Kindern ergibt die Rechnung 28.4 und
  // das Minimum 30 greift — die n=5-Geometrie unten bleibt unveraendert.
  const kidRow = (kidCap - 1) * KID_GAP + 2 * 4.2;
  const pitch = Math.max(30, kidRow + 6);
  // Rand des letzten (rechtesten) Clusters, damit die "+N"-Ziffer sich
  // relativ dazu platzieren kann statt an einem festen HEX-Bruchteil, der bei
  // der naechsten Pitch-Aenderung wieder auf einem Kopf landen kann (siehe
  // Kommentar unten bei "rest > 0").
  let lastClusterOuterX = null;

  groups.forEach((g, i) => {
    let hx;
    let hy;
    if (hasKids) {
      const n = groups.length;
      // Bei n=5 greift der HEX-Anteil (96.6 px), nicht der Pitch: ~24 px
      // zwischen den Koepfen, rund 3.75 px Luft zwischen den aeussersten
      // Kinderpunkten zweier Nachbarcluster mit je drei Kindern. Der alte
      // Faktor 0.92 liess dort nur ~19 px, die Punkte beruehrten sich
      // (Kantenabstand rechnerisch -1 px). Mit den echten agent-colony-Daten
      // geprueft; der Zwei-mal-drei-Fall ist rechnerisch, nicht live
      // beobachtet. Bei n<=2 zieht der Pitch (49.4 px fuer sechs Kinder).
      const spread = Math.min(SPREAD, (n - 1) * pitch);
      hx = cx + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
      hy = cy + HEX * 0.11;
    } else {
      // Bogen unterhalb der Mitte, in zwei Reihen ab sieben Punkten. Ein
      // voller Ring liess die Sprechblasen der oberen Figuren ins Label ragen.
      const row = i < 6 ? 0 : 1;
      const inRow = row === 0 ? Math.min(groups.length, 6) : groups.length - 6;
      const idx = row === 0 ? i : i - 6;
      const t0 = inRow === 1 ? 0.5 : idx / (inRow - 1);
      const ang = Math.PI * (0.12 + 0.76 * t0);
      const rad = row === 0 ? ARC_R : ARC_R2;
      hx = cx + rad * Math.cos(ang);
      hy = cy + rad * Math.sin(ang) * 0.62 + HEX * 0.1;
    }

    const drawn = g.kids.slice(0, kidCap);
    const kidY = hy + KID_DROP;
    const kidX = (n) => hx + (n - (drawn.length - 1) / 2) * KID_GAP;

    if (hasKids && i === groups.length - 1) {
      // Aeusserster Punkt dieses Kopfes: Punkt (Radius 5, hohler Kringel
      // 4.5 ohne Kopf), Sprechblase (Halbbreite 6) oder das aeusserste Kind
      // (±(drawn.length-1)/2 * KID_GAP vom Kopf, plus 4.2 statt Punktradius
      // 3.2 — ein Kind im prompt-Zustand bekommt eine kleine Sprechblase mit
      // Halbbreite 4.2, die reicht weiter als der Punkt) — je nachdem, was
      // am weitesten nach aussen reicht.
      const headEdge = g.head ? 5 : 4.5;
      const bubbleEdge = g.head && BUBBLE_STATES.has(g.head.state) ? 6 : 0;
      const kidEdge = drawn.length ? ((drawn.length - 1) / 2) * KID_GAP + 4.2 : 0;
      lastClusterOuterX = hx + Math.max(headEdge, bubbleEdge, kidEdge);
    }

    // Stiele zuerst, damit die Punkte darauf liegen
    if (drawn.length) {
      ctx.strokeStyle = 'rgba(230,237,243,.38)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let n = 0; n < drawn.length; n++) {
        ctx.moveTo(hx, hy + 4);
        ctx.lineTo(kidX(n), kidY - 3);
      }
      ctx.stroke();
    }

    if (g.head) {
      mark(g.head, hx, hy, 5);
      drawAgentDot(g.head, hx, hy, 5);
      if (BUBBLE_STATES.has(g.head.state)) drawBubble(hx, hy, t, i, g.head.state);
    } else {
      // Kopf fehlt: hohler Kringel statt eines Punktes, der eine Hauptsession
      // behaupten wuerde, die hier gar nicht laeuft.
      ctx.strokeStyle = 'rgba(230,237,243,.45)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawn.forEach((k, n) => {
      mark(k, kidX(n), kidY, 3.2);
      drawAgentDot(k, kidX(n), kidY, 3.2);
      // Nur `prompt`, nie `waiting`: das kommt fuer Kinder gar nicht erst
      // aus dem Collector, ihr Turn-Ende beantwortet der Parent.
      if (k.state === 'prompt') drawBubble(kidX(n), kidY, t, i * 7 + n, 'prompt', true);
    });

    // Der Zaehler traegt die Wahrheit — gezeichnet werden hoechstens `kidCap`
    // Punkte, laufen koennen deutlich mehr.
    if (g.kids.length) {
      ctx.fillStyle = 'rgba(230,237,243,.9)';
      ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(g.kids.length), hx + 6, hy - 3);
      ctx.textAlign = 'center';
    }
  });

  // Abgeschnittene Gruppen benennen, statt sie stillschweigend wegzulassen
  if (rest > 0) {
    ctx.fillStyle = 'rgba(230,237,243,.7)';
    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const label = '+' + rest;
    const halfLabel = ctx.measureText(label).width / 2;
    let restX;
    if (hasKids && lastClusterOuterX !== null) {
      // Relativ zum tatsaechlichen Rand des letzten Clusters statt zu einem
      // festen HEX-Bruchteil platziert: ein fester Bruchteil (zuletzt 0.62,
      // dann 0.8 HEX) driftet bei jeder weiteren Aenderung an Spread oder
      // Pitch wieder auf den Kopf oder ein Kind, wie es zwischen 0.62 und
      // 0.8 schon einmal passiert ist. 4 px Luft zwischen dem aeussersten
      // Punkt (Kopf/Sprechblase/Kind, je nachdem was am weitesten reicht)
      // und dem Ziffernrand.
      //
      // Bewusst KEIN nachtraeglicher Clamp mehr gegen die Hex-Kante: ein
      // Clamp, der nur die *rechte* Textkante an der Kante festhaelt, zieht
      // bei einem breiteren Label (zweistelliges rest, "+10" statt "+7")
      // die *linke* Kante immer weiter nach links -- zurueck auf genau den
      // Cluster, den er freihalten sollte (Review-Fund Fix-Runde 2). Wenn
      // sich "Cluster frei" und "Ziffer bleibt in der Hex-Kontur" nicht
      // beide erfuellen lassen, gewinnt der Cluster (Controller-Entscheidung
      // Fix-Runde 2): die Figuren tragen die Information, die Ziffer ist
      // sekundaer und darf notfalls ein paar Pixel aus der Kontur ragen.
      //
      // Zahlen fuer den ungeguenstigsten Fall (letzter Cluster mit drei
      // Kindern, Aussenkante 59.5 px, siehe oben; Label "+10" dreistellig,
      // halbe Textbreite ~8 px bei dieser 9px-Schrift): Zielposition
      // 59.5 + 4 + 8 = 71.5 px, rechte Textkante 79.5 px, halfWidthAt an
      // dieser Zeile ~75.3 px -- rund 4.2 px ueber die Hex-Kante hinaus.
      // Der haeufige Fall (kurzes Label, kein Drei-Kinder-Cluster ganz
      // aussen) bleibt komfortabel innerhalb der Kontur.
      restX = lastClusterOuterX + 4 + halfLabel;
    } else {
      // Bogen-Layout: unveraendert, die obere Reihe endet dort schon bei
      // 0.46 HEX, 0.62 HEX hat immer genug Abstand.
      restX = cx + HEX * 0.62;
    }
    ctx.fillText(label, restX, cy + HEX * 0.11);
  }
}

export { AGENT_ZONE, ARC_R, ARC_R2, BUBBLE_STATES, KID_DROP, KID_GAP, SPREAD, agentAt, agentHits, byInterest, drawAgents, groupAgents, resetAgentHits };
