/* Bewegung der Figuren in der 3D-Ansicht (seit 2026-09-14, Andrés Wunsch):
 * eine Hauptfigur laeuft langsam ueber ihre ganze Wabe und weicht dabei
 * Tagesbauten, Gelaende, Plattformkante und den anderen Figuren aus;
 * gehoert ihr Projekt einer Familie an (Repo mit Sub-Repos), geht sie
 * gelegentlich auf eine der Nachbarwaben hinueber und laeuft dort weiter;
 * eine neue Hauptsession laeuft einmal vom Hangar zu ihrem Projekt; Kinder
 * fliegen als Drohnen um ihren Kopf (Abschnitt "Kinder"). Reine Rechnung,
 * kein three-Import.
 *
 * Koordinaten: das Umherlaufen rechnet plattform-lokal (x, z relativ zur
 * Mitte der Plattform, auf der die Figur gerade steht -- `m.field`), damit
 * eine Figur bei Umordnungsfahrt und Hubfahrt mit ihrer Plattform mitfaehrt,
 * ohne dass hier jemand davon weiss. Nur unterwegs (`travel`: Hangar-Weg und
 * Gang zur Nachbarwabe) wird in Weltkoordinaten gerechnet, weil der Weg
 * Plattformen ueberquert; bei der Ankunft wird er zurueck in lokale
 * Koordinaten der Zielplattform umgerechnet.
 * Luecken zwischen Plattformen ueberspringt die Figur (Andrés Wunsch vom
 * 2026-09-14, vorher sackte sie auf den Boden ab): kurz vor der Kante sucht
 * sie entlang ihrer Richtung die naechste Plattform und springt im Bogen
 * dorthin; liegt keine in Reichweite, springt sie hinunter auf den Boden,
 * geht, und springt an der naechsten Kante wieder hinauf. Seit dem
 * 2026-09-15 huepft sie auch ueber die blosse Fuge zwischen zwei gleich
 * hohen Nachbarwaben -- zu ueberwinden gibt es dort nichts, der Schritt von
 * Wabe zu Wabe soll aber einer bleiben.
 *
 * Bewegung ist Kosmetik, kein Signal: den Zustand tragen weiter Farbe und
 * Hologramm, in beiden Renderern gleich. Der Zustand bestimmt hier nur, wer
 * laeuft: working, waiting und prompt gehen umher (mit Pausen je Zustand),
 * idle geht zu seinem Heimplatz und setzt sich dort auf den Boden (in
 * clean steht die Kapsel still). Nichts hiervon ueberlebt einen
 * Reload; es gibt nichts zu merken.
 *
 * Wer wohin gehoert, sagt weiter der Collector: `m.home` ist die Wabe, auf
 * der die Figur ihren Platz in der Anordnung hat, und dorthin geht sie
 * zurueck, sobald sie idle wird. Der Gang zur Nachbarwabe bleibt Kosmetik
 * innerhalb derselben Familie -- also innerhalb desselben Projekts; das
 * Panel nennt ohnehin den genauen cwd. */

import { DAY_BASE, DAY_PITCH, DAY_W, DAY_X0 } from '../skyline.mjs';
import { cellsOf } from '../hexmap.mjs';
import { DAY_N, terrainSlots } from './builds.mjs';
import { FLOOR_Y, TILE_R, insideHex, rimDist } from './world.mjs';

const WALK = 6;            // Welteinheiten je Sekunde beim Umherlaufen: halbe Figurenhoehe, "langsam"
const TRAVEL_WALK = 14;    // unterwegs: Hangar-Weg und Gang zur Nachbarwabe
const TURN = 6;            // Drehrate in rad/s
const EDGE = 7;            // Abstand zur Plattformkante (Leuchtkante ist 5 breit)
const BODY_R = 3;          // Figurenradius, wie R_HEAD der Kapsel
const LOOK = 7;            // Vorausschau: ab diesem Abstand zu einem Hindernis weicht die Figur aus
const ARRIVE = 1.2;        // naeher als das am Ziel heisst angekommen
const STRIDE = 11;         // Welteinheiten je Schrittzyklus (beide Beine): die Gangphase haengt am Weg, nicht an der Zeit
const MAX_DT = 0.1;        // Sekunden je Frame hoechstens: nach Tab-Wechsel oder Pause kein Sprung
// Sekunden Stillstand zwischen zwei Wegen. idle fehlt mit Absicht: eine
// deaktivierte Figur geht zu ihrem Platz und setzt sich (Andrés Wunsch vom
// 2026-09-14: nur wer arbeitet, wartet oder fragt, laeuft herum).
const PAUSE = { working: [1.5, 4], waiting: [2, 5], prompt: [2, 5] };
const SIT_EASE = 3;        // 1/s: Hinsetzen und Aufstehen (Blend der Pose)
const NEW_MAX_AGE = 5;     // Minuten: nur eine wirklich frische Session laeuft aus dem Hangar
const LANDER_R = 24;       // Kit: Grundflaeche der Station (lander_base 42) plus Rand
/* Der Sperrkreis eines Gelaendestuecks ist kleiner als das Stueck selbst
 * (Andrés Wunsch vom 2026-09-15). Seit sechs grosse Bauten je Wabe stehen,
 * lagen die Sperrkreise (r + BODY_R, Ausweichen schon ab r + BODY_R + LOOK)
 * so dicht beieinander und so nah an der Kante, dass ganze Zonen nicht mehr
 * erreichbar waren und die Figuren davor haengen blieben. Lieber ein Stueck
 * Clipping beim Vorbeigehen als eine Sackgasse. */
const OBS_SHRINK = 0.6;
const STUCK_S = 3;         // Sekunden ohne Fortschritt: neues Ziel (lange Wege fuehren laenger um ein Hindernis herum)
const TREK_P = 0.3;        // Anteil der Ziele, die auf einer Nachbarwabe derselben Familie liegen
const TRAVEL_STUCK_S = 4;  // Sekunden ohne Fortschritt unterwegs: an Ort und Stelle ankommen
// Sprung ueber eine Luecke (nur unterwegs): Absprung, sobald der Punkt
// HOP_LOOK voraus nicht mehr auf derselben Flaeche liegt; Landung EDGE
// hinter der Kante der naechsten Plattform, bis HOP_MAX weit; sonst
// HOP_DOWN weit hinunter auf den Boden. In der Luft schneller als zu Fuss,
// die Beine bleiben gespreizt (Gangphase eingefroren).
const HOP_LOOK = 5;
const HOP_MAX = 42;        // halber Plattformradius: eine Luecke, kein Flug ueber eine leere Zelle
const HOP_DOWN = 12;
const HOP_SPEED = 20;      // Welteinheiten je Sekunde in der Luft
const HOP_H = 6;           // Scheitel ueber der Verbindungslinie, halbe Figurenhoehe
const LAND_R = TILE_R - EDGE * 1.16; // insideHex-Radius, dessen Apothem EDGE innerhalb der Kante liegt

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);

/* ---------- Hindernisse ---------- */

/* Hindernisse einer Plattform, lokal: Kreise { x, z, r, cell } fuer die
 * Gelaendeplaetze (builds.mjs::terrainSlots) und die Station, eine Strecke
 * { ax, az, bx, bz, r, cell } fuer das Skyline-Band, wenn das Feld Commits
 * hat. Einmal je Feld, Skin, Balkenlage und Zellenzahl gerechnet; im Kit
 * fuellt ein Stueck seinen Platz (t.half), in clean steht dort nur eine
 * kleinere Kiste.
 *
 * `cell` ist der Index der Zelle, auf der das Stueck steht -- dieselbe
 * Zaehlung wie cellsOf() und builds.mjs::sync(). Die Zusatzwaben eines
 * grossen Projekts tragen sieben eigene Plaetze (EXTRA_SLOTS, dichter als
 * die Hauptwabe); bis zum 2026-09-15 kannte diese Liste nur die Hauptwabe,
 * und die Figuren liefen dort durch die Bauten hindurch. Die Mittelpunkte
 * stehen relativ zur eigenen Zelle, nicht zur Hauptzelle: wo eine Zelle
 * liegt, weiss erst der Aufrufer je Frame (cellWorldOf interpoliert
 * waehrend einer Umordnungsfahrt), deshalb addiert erst `nearest` den
 * Versatz aus `cells`. Die Zellenzahl waechst mit der Arbeit im Projekt
 * (hexmap.sizeOf) und gehoert darum in den Cache-Schluessel. */
const obsCache = new Map();
function obstaclesOf(h, isStation, kit) {
  const nCells = isStation ? 1 : Math.max(1, cellsOf(h).length);
  const key = (isStation ? 'station' : h.id) + ':' + (kit ? 'kit' : 'clean') + ':' + (h.commitsByDay?.some(Boolean) ? 1 : 0) + ':' + nCells;
  let o = obsCache.get(key);
  if (o) return o;
  o = [];
  if (isStation) {
    if (kit) o.push({ x: 0, z: 0, r: LANDER_R, cell: 0 });
  } else {
    for (let ci = 0; ci < nCells; ci++) {
      for (const t of terrainSlots(h, ci)) o.push({ x: t.x, z: t.z, r: (kit ? t.half : t.half * 0.45) * OBS_SHRINK, cell: ci });
    }
    // Label, Skyline und Figuren gibt es nur auf der Hauptwabe (builds.mjs)
    if (h.commitsByDay?.some(Boolean)) {
      o.push({ ax: DAY_X0, az: DAY_BASE, bx: DAY_X0 + (DAY_N - 1) * DAY_PITCH + DAY_W, bz: DAY_BASE, r: DAY_W / 2 + 1, cell: 0 });
    }
  }
  obsCache.set(key, o);
  return o;
}

/* Der Punkt eines Hindernisses, der (px, pz) am naechsten liegt -- beides
 * relativ zur Hauptzelle. Eine Zelle, die es gerade nicht (mehr) gibt, wird
 * wie die Hauptzelle behandelt; der naechste Frame hat den passenden
 * Cache-Eintrag. */
function nearest(o, px, pz, cells) {
  const c = o.cell ? cells[o.cell] : null; // die Hauptzelle liegt im Ursprung
  const ox = c ? c.dx : 0;
  const oz = c ? c.dz : 0;
  if (o.ax === undefined) return [o.x + ox, o.z + oz];
  const ax = o.ax + ox;
  const az = o.az + oz;
  const dx = o.bx - o.ax;
  const dz = o.bz - o.az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return [ax + dx * t, az + dz * t];
}

/* Weiches Ausweichen ab LOOK vor einem Hindernis: ein Stueck weg davon und
 * ein Stueck quer dazu, auf der Seite, die dem Wunsch naeher liegt -- so
 * gleitet die Figur an einem Band entlang, statt davor stehen zu bleiben. */
function steer(px, pz, obs, dir, cells) {
  for (const o of obs) {
    const [cx, cz] = nearest(o, px, pz, cells);
    let nx = px - cx;
    let nz = pz - cz;
    let d = Math.hypot(nx, nz);
    if (d < 1e-6) { nx = 1; nz = 0; d = 1; }
    const keep = o.r + BODY_R + LOOK;
    if (d >= keep) continue;
    nx /= d;
    nz /= d;
    const k = (keep - d) / LOOK;
    let tx = -nz;
    let tz = nx;
    if (tx * dir.x + tz * dir.z < 0) { tx = -tx; tz = -tz; }
    dir.x += nx * k * 0.8 + tx * k;
    dir.z += nz * k * 0.8 + tz * k;
  }
}

/* ---------- Die begehbare Flaeche ---------- */

/* Ein Projekt belegt seit den Mehrfach-Waben bis zu fuenf Zellen, die
 * lueckenlos aneinanderliegen und als eine Flaeche gezeichnet werden
 * (hexmap.cellsOf). Eine Figur laeuft ueber die ganze Flaeche, nicht ueber
 * ein einzelnes Sechseck: `cells` sind die Mittelpunkte der Zellen relativ
 * zur Hauptzelle, in der alles hier rechnet.
 *
 * Deshalb tritt an die Stelle der analytischen Kantendistanz (rimDist, gilt
 * nur fuer ein Sechseck um den Ursprung) eine Probe: `onArea` fragt, ob ein
 * Punkt in irgendeiner Zelle liegt, `safeArea` zusaetzlich, ob er in allen
 * sechs Kantenrichtungen EDGE Luft hat. An einer Fuge zwischen zwei eigenen
 * Zellen ist diese Luft die Nachbarzelle -- dort laeuft die Figur durch,
 * ohne dass jemand die Fuge kennen muss; an der Aussenkante des Klumpens
 * fehlt sie, und dieselbe Probe haelt die Figur auf. */
const onArea = (x, z, cells, r = TILE_R) => cells.some((c) => insideHex(x - c.dx, z - c.dz, r));

// Die sechs Kantennormalen eines flat-top-Sechsecks (30, 90, ... Grad)
const NORMALS = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = Math.PI / 6 + (i * Math.PI) / 3;
  return { x: Math.cos(a), z: Math.sin(a) };
});

function safeArea(x, z, cells) {
  if (!onArea(x, z, cells)) return false;
  for (const n of NORMALS) if (!onArea(x + n.x * EDGE, z + n.z * EDGE, cells)) return false;
  return true;
}

/* Die Mitte der Zelle, in der ein Punkt liegt (oder der naechsten): das Ziel,
 * zu dem Ausweichen und Korrektur ihn schieben. */
function homeCell(x, z, cells) {
  let best = cells[0];
  let bd = Infinity;
  for (const c of cells) {
    const d = Math.hypot(x - c.dx, z - c.dz);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/* Weiches Ausweichen vor der Aussenkante der Flaeche: liegt der Punkt LOOK
 * voraus nicht mehr sicher darauf, druecke die Richtung zur Mitte der Zelle,
 * in der die Figur gerade steht. */
function steerRim(px, pz, dir, cells) {
  const ax = px + dir.x * LOOK;
  const az = pz + dir.z * LOOK;
  if (safeArea(ax, az, cells)) return;
  const c = homeCell(px, pz, cells);
  const dx = c.dx - px;
  const dz = c.dz - pz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return;
  dir.x += (dx / d) * 1.5;
  dir.z += (dz / d) * 1.5;
}

/* Harte Korrektur nach dem Schritt: nie in einem Hindernis. */
function settle(p, obs, cells) {
  for (const o of obs) {
    const [cx, cz] = nearest(o, p.x, p.z, cells);
    let dx = p.x - cx;
    let dz = p.z - cz;
    let d = Math.hypot(dx, dz);
    const keep = o.r + BODY_R;
    if (d >= keep) continue;
    if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
    p.x = cx + (dx / d) * keep;
    p.z = cz + (dz / d) * keep;
  }
}

/* ... und nie ueber der Aussenkante (nur beim Umherlaufen; unterwegs darf sie
 * ueberschritten werden). Schrittweise zur Zellmitte, bis der Punkt wieder
 * sicher liegt -- ein einzelner Zug wie frueher (Skalierung auf die
 * Kantendistanz) trifft bei mehreren Zellen nicht mehr. */
function settleRim(p, cells) {
  if (safeArea(p.x, p.z, cells)) return;
  const c = homeCell(p.x, p.z, cells);
  const dx = c.dx - p.x;
  const dz = c.dz - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return;
  for (let i = 0; i < 24; i++) {
    p.x += (dx / d) * 2;
    p.z += (dz / d) * 2;
    if (safeArea(p.x, p.z, cells)) return;
  }
  p.x = c.dx;
  p.z = c.dz;
}

function blocked(x, z, obs, cells) {
  if (!safeArea(x, z, cells)) return true;
  return obs.some((o) => {
    const [cx, cz] = nearest(o, x, z, cells);
    return Math.hypot(x - cx, z - cz) < o.r + BODY_R + 1;
  });
}

/* Unter welchem Feld steht ein Weltpunkt -- Zusatzwaben eingeschlossen,
 * sonst haelt eine reisende Figur den Klumpen eines Projekts fuer Boden und
 * springt mitten hinein. */
function fieldUnder(x, z, fields) {
  for (const f of fields) if (onArea(x - f.w.x, z - f.w.z, f.cells, TILE_R + 2)) return f;
  return null;
}

const landable = (f, x, z) => onArea(x - f.w.x, z - f.w.z, f.cells, LAND_R);

/* ---------- Gemeinsames ---------- */

function turn(m, want, dt) {
  let d = want - m.heading;
  d = Math.atan2(Math.sin(d), Math.cos(d)); // kuerzester Bogen
  const step = TURN * dt;
  m.heading += Math.abs(d) <= step ? d : Math.sign(d) * step;
  m.heading = Math.atan2(Math.sin(m.heading), Math.cos(m.heading)); // in -pi..pi halten
}

/* Einen Schritt gehen: Position, Gangphase (am Weg), Gehanteil (weich, fuer
 * das Ein- und Ausblenden des Schwingens) und Blickrichtung. Die Figur
 * schaut nach +z, rotation.y = atan2(vx, vz) dreht sie in Laufrichtung. */
function advance(m, vx, vz, dt) {
  const v = Math.hypot(vx, vz);
  m.x += vx * dt;
  m.z += vz * dt;
  m.phase += ((v * dt) / STRIDE) * Math.PI * 2;
  m.gait += (Math.min(1, v / WALK) - m.gait) * Math.min(1, dt * 8);
  if (v > 0.1) turn(m, Math.atan2(vx, vz), dt);
}

/* Abstand zu den anderen Koepfen. `others` sind die Koepfe aller Felder
 * dieses Frames; gemieden wird nur, wer auf derselben Plattform umherlaeuft
 * -- zwei Figuren auf verschiedenen Waben haben zwar aehnliche lokale
 * Koordinaten, stehen aber weit auseinander. */
function separate(m, others, dir) {
  for (const o of others) {
    if (o === m || o.mode !== 'wander' || o.field !== m.field) continue;
    const dx = m.x - o.x;
    const dz = m.z - o.z;
    const d = Math.hypot(dx, dz);
    const keep = 2 * BODY_R + 3;
    if (d >= keep || d < 1e-6) continue;
    const k = ((keep - d) / keep) * 1.5;
    dir.x += (dx / d) * k;
    dir.z += (dz / d) * k;
  }
}

/* ---------- Umherlaufen ---------- */

/* Ein neues Ziel irgendwo auf der Plattform, gleichmaessig ueber die Flaeche
 * (sqrt der Zufallszahl, sonst draengen sich die Ziele in der Mitte). Bis zum
 * 2026-09-14 lag es in einem Radius von 16 um den Heimplatz — Andrés Urteil
 * am laufenden Bild: "laufen nur hin und her auf einem Fleck". Der Heimplatz
 * ist seither nur noch Startpunkt und Sitzplatz, das Revier ist die ganze
 * Flaeche des Projekts: erst eine seiner Zellen, darin ein Punkt (sqrt der
 * Zufallszahl, sonst draengen sich die Ziele in der Mitte). `blocked` wirft
 * weg, was ausserhalb liegt, zu nah an der Aussenkante oder in Bauten,
 * Gelaende oder Station. */
function pickTarget(obs, cells) {
  for (let i = 0; i < 24; i++) {
    const c = cells[Math.floor(Math.random() * cells.length)];
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * rimDist(a);
    const x = c.dx + Math.cos(a) * r;
    const z = c.dz + Math.sin(a) * r;
    if (!blocked(x, z, obs, cells)) return { x, z };
  }
  return null;
}

/* Ein Ziel auf einer der Nachbarwaben derselben Familie, oder null, wenn es
 * keine gibt (Einzelprojekt, zugeklappte Familie) oder dort nichts frei ist.
 * `kin` sind die sichtbaren Felder der Familie, die eigene eingeschlossen. */
function pickTrek(m, kin) {
  const others = kin.filter((f) => f.key !== m.field);
  if (!others.length) return null;
  const f = others[Math.floor(Math.random() * others.length)];
  const t = pickTarget(f.obs, f.cells);
  return t ? { key: f.key, x: t.x, z: t.z } : null;
}

/* Vom Umherlaufen auf den Weg wechseln: die lokalen Koordinaten der
 * aktuellen Plattform werden zu Weltkoordinaten, das Ziel merkt sich `m.dest`
 * als Plattform plus lokalem Punkt darauf (nicht als Weltpunkt -- die
 * Plattform faehrt bei Umordnung und Hubfahrt). */
function startTravel(m, here) {
  m.x += here.w.x;
  m.z += here.w.z;
  m.y = here.w.y;
  m.mode = 'travel';
  m.target = null;
  m.seated = false;
  m.hop = null;
  m.lastD = Infinity;
  m.stuck = 0;
}

/* Ein Frame Umherlaufen: Ziel waehlen, hingehen, Pause je Zustand,
 * naechstes Ziel. Wer haengt (kein Fortschritt), gibt das Ziel auf. Ein Teil
 * der Ziele liegt auf einer Nachbarwabe derselben Familie (TREK_P) -- dann
 * wechselt die Figur in den Modus `travel` und der Aufrufer liest ihre
 * Position ab diesem Frame in Weltkoordinaten. idle: zurueck auf die eigene
 * Wabe und dort auf den Heimplatz, sitzen (m.seated, m.sit ist der Blend fuer
 * die Pose), Blick nach +z; wer wieder aktiv wird, steht auf und geht nach
 * einem Augenblick los. `others` sind die Koepfe aller Felder, `separate`
 * filtert auf dieselbe Plattform. */
function stepWander(m, dt, now, state, here, others, kin) {
  const pause = PAUSE[state];
  const obs = here.obs;
  const cells = here.cells;
  if (state === 'idle') {
    if (m.field !== m.home) {
      // Feierabend auf fremder Wabe: erst nach Hause, dann setzen
      m.dest = { key: m.home, x: m.hx, z: m.hz };
      startTravel(m, here);
      return;
    }
    if (!m.seated) {
      const d = Math.hypot(m.hx - m.x, m.hz - m.z);
      if (d < ARRIVE) {
        m.seated = true;
        m.target = null;
      } else if (!m.target || m.target.x !== m.hx || m.target.z !== m.hz) {
        m.target = { x: m.hx, z: m.hz };
        m.lastD = Infinity;
        m.stuck = 0;
      }
    }
  } else if (m.seated) {
    m.seated = false;
    m.pauseUntil = now + 800;
  } else if (!m.target && now >= m.pauseUntil) {
    const far = kin.length > 1 && Math.random() < TREK_P ? pickTrek(m, kin) : null;
    if (far) {
      m.dest = far;
      startTravel(m, here);
      return;
    }
    m.target = pickTarget(obs, cells);
    if (!m.target) m.pauseUntil = now + 2000;
    m.lastD = Infinity;
    m.stuck = 0;
  }
  m.sit += ((m.seated ? 1 : 0) - m.sit) * Math.min(1, dt * SIT_EASE);
  let vx = 0;
  let vz = 0;
  if (m.target) {
    const dx = m.target.x - m.x;
    const dz = m.target.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d < ARRIVE) {
      m.target = null;
      m.pauseUntil = now + rand(pause ?? [1, 2]) * 1000;
    } else {
      const dir = { x: dx / d, z: dz / d };
      steer(m.x, m.z, obs, dir, cells);
      steerRim(m.x, m.z, dir, cells);
      separate(m, others, dir);
      const n = Math.hypot(dir.x, dir.z) || 1;
      vx = (dir.x / n) * WALK;
      vz = (dir.z / n) * WALK;
      if (d > m.lastD - 0.02) m.stuck += dt;
      else m.stuck = 0;
      m.lastD = Math.min(m.lastD, d);
      if (m.stuck > STUCK_S) {
        m.target = null;
        m.pauseUntil = now + 1000;
      }
    }
  }
  advance(m, vx, vz, dt);
  if (m.seated) {
    // sitzt genau auf dem Heimplatz und dreht sich zur Grundstellung der
    // Kamera (+z)
    m.x = m.hx;
    m.z = m.hz;
    turn(m, 0, dt);
  } else {
    settle(m, obs, cells);
    settleRim(m, cells);
  }
}

/* ---------- Unterwegs ---------- */

/* Ein Frame auf dem Weg zu `m.dest` (Weltkoordinaten): vom Hangar zum
 * eigenen Projekt, zu einer Nachbarwabe derselben Familie oder von dort
 * zurueck. Die Figur laeuft ueber die Plattformen, die dazwischen liegen,
 * weicht dort deren Hindernissen aus, springt an jeder Kante (planHop/fly)
 * und nimmt sonst die Hoehe der Flaeche unter sich (Boden zwischen den
 * Plattformen, sonst die Oberkante). Bei der Ankunft wird sie zur
 * umherlaufenden Figur in lokalen Koordinaten der Zielplattform.
 *
 * Das Ziel wird je Frame aus `byId` nachgeschlagen, nicht beim Aufbruch
 * gemerkt: die Plattform faehrt bei Umordnung und Hubfahrt, ein gemerkter
 * Weltpunkt liefe ihr davon. Ist sie unterwegs verschwunden (Familie
 * zugeklappt, Feld weg), zielt die Figur auf ihre eigene Wabe; fehlt auch
 * die, kommt sie an Ort und Stelle an. */
function stepTravel(m, dt, now, fields, byId) {
  const dst = byId.get(m.dest?.key) ?? byId.get(m.home);
  if (!dst) {
    m.mode = 'wander';
    m.dest = null;
    m.hop = null;
    m.target = null;
    return;
  }
  if (dst.key !== m.dest?.key) m.dest = { key: dst.key, x: m.hx, z: m.hz };
  const gx = dst.w.x + m.dest.x;
  const gz = dst.w.z + m.dest.z;
  const dx = gx - m.x;
  const dz = gz - m.z;
  const d = Math.hypot(dx, dz);
  if (d > m.lastD - 0.02) m.stuck += dt;
  else m.stuck = 0;
  m.lastD = Math.min(m.lastD, d);
  if (d < ARRIVE || m.stuck > TRAVEL_STUCK_S) {
    m.mode = 'wander';
    m.field = dst.key;
    m.hop = null;
    m.x = d < ARRIVE ? m.x - dst.w.x : m.dest.x;
    m.z = d < ARRIVE ? m.z - dst.w.z : m.dest.z;
    m.dest = null;
    m.target = null;
    m.pauseUntil = now + 1500;
    advance(m, 0, 0, dt);
    return;
  }
  if (m.hop) {
    fly(m, dt);
    return;
  }
  const dir = { x: dx / d, z: dz / d };
  const under = fieldUnder(m.x, m.z, fields);
  if (under) steer(m.x - under.w.x, m.z - under.w.z, under.obs, dir, under.cells);
  const n = Math.hypot(dir.x, dir.z) || 1;
  dir.x /= n;
  dir.z /= n;
  /* Kante voraus: Sprung planen und gleich den ersten Schritt fliegen -- auch
   * dort, wo zwei Plattformen gleicher Hoehe unmittelbar aneinanderstossen.
   * Seit TILE_FILL 1 gaebe es dort nichts zu ueberwinden, und der Huepfer war
   * bis zum 2026-09-15 unterdrueckt; Andrés Urteil am laufenden Bild: der
   * Schritt von Wabe zu Wabe soll trotzdem einer sein. Fallen darf die Figur
   * dabei nicht -- auf ebenem Grund springt sie nur, wenn planHop drueben
   * wirklich einen Landeplatz findet (`drop` false). Ohne das liesse ein Gang
   * dicht an einer Fuge entlang sie in die Fuge hinunterspringen, in der gar
   * keine Luecke ist. */
  const ahead = fieldUnder(m.x + dir.x * HOP_LOOK, m.z + dir.z * HOP_LOOK, fields);
  if (ahead !== under) {
    const drop = !ahead || !under || Math.abs(ahead.w.y - under.w.y) >= 1;
    m.hop = planHop(m, dir, under, fields, { x: gx, z: gz, y: dst.w.y, d }, drop);
    if (m.hop) {
      m.phase = Math.PI / 2; // Beine gespreizt, ein Bein vor, eins zurueck
      fly(m, dt);
      return;
    }
  }
  const sp = Math.min(TRAVEL_WALK, d / Math.max(dt, 1e-3));
  advance(m, dir.x * sp, dir.z * sp, dt);
  const over = fieldUnder(m.x, m.z, fields);
  if (over) {
    const p = { x: m.x - over.w.x, z: m.z - over.w.z };
    settle(p, over.obs, over.cells);
    m.x = over.w.x + p.x;
    m.z = over.w.z + p.z;
  }
  const ys = over ? over.w.y : FLOOR_Y;
  m.y += (ys - m.y) * Math.min(1, dt * 8);
}

/* Landepunkt eines Sprungs von der Position in Richtung dir (Einheitsvektor):
 * der erste Punkt bis HOP_MAX, der EDGE tief auf einer anderen Plattform
 * liegt. Keine in Reichweite: von einer Plattform hinunter auf den Boden
 * (nur wenn `drop`, sonst gar nicht), vom Boden aus gar nicht (weitergehen).
 * Nie ueber das Ziel hinaus. */
function planHop(m, dir, here, fields, goal, drop) {
  let land = null;
  for (let s = HOP_LOOK; s <= HOP_MAX; s += 2) {
    const x = m.x + dir.x * s;
    const z = m.z + dir.z * s;
    const f = fieldUnder(x, z, fields);
    if (f && f !== here && landable(f, x, z)) {
      land = { x, z, y: f.w.y, len: s };
      break;
    }
  }
  if (!land) {
    if (!here || !drop) return null;
    land = { x: m.x + dir.x * HOP_DOWN, z: m.z + dir.z * HOP_DOWN, y: FLOOR_Y, len: HOP_DOWN };
  }
  if (land.len > goal.d) land = { x: goal.x, z: goal.z, y: goal.y, len: goal.d };
  return { x0: m.x, y0: m.y, z0: m.z, x1: land.x, y1: land.y, z1: land.z, len: Math.max(land.len, 1e-3), s: 0 };
}

/* Ein Frame in der Luft: gerade Strecke in der Ebene, Parabel in der Hoehe
 * (Scheitel HOP_H ueber der Verbindungslinie, bei Sprung aufwaerts hoeher,
 * damit die Figur die Kante nicht schneidet). Blick in Sprungrichtung,
 * Gangphase eingefroren. Bei s = 1 exakt auf dem Landepunkt. */
function fly(m, dt) {
  const h = m.hop;
  h.s = Math.min(1, h.s + (dt * HOP_SPEED) / h.len);
  const s = h.s;
  const rise = Math.max(0, h.y1 - h.y0);
  m.x = h.x0 + (h.x1 - h.x0) * s;
  m.z = h.z0 + (h.z1 - h.z0) * s;
  m.y = h.y0 + (h.y1 - h.y0) * s + (HOP_H + rise * 0.5) * 4 * s * (1 - s);
  m.gait += (1 - m.gait) * Math.min(1, dt * 8);
  turn(m, Math.atan2(h.x1 - h.x0, h.z1 - h.z0), dt);
  if (s >= 1) {
    m.y = h.y1;
    m.hop = null;
  }
}

/* ---------- Kinder ---------- */

/* Die Drohnen der Subagenten fliegen seit dem 2026-09-16 selbst (Andrés
 * Wunsch: "lebendiger"). Bis dahin glitt jedes Kind auf seinen Platz in
 * einer Reihe vor dem Kopf und uebernahm dessen Blickrichtung. Jetzt zieht
 * eine unterkritisch gedaempfte Feder die Drohne zu einem Ziel -- sie
 * schiesst beim Bremsen ein Stueck darueber hinaus --, und das Ziel sagt der
 * Zustand:
 *  - working (und waiting, das ein Kind laut Collector nicht hat): Kreisbahn
 *    um den Kopf, Geschwister gleichmaessig verteilt und gleich schnell, damit
 *    sie sich nicht treffen
 *  - prompt: vor das Visier des Kopfes, Blick zu ihm
 *  - idle: landen, auf dem Parkplatz vor dem Heimplatz des Kopfes (die Stelle
 *    der alten Reihe), Schweben aus. Das Bild wird ruhiger, und wer arbeitet,
 *    faellt auf
 * Blick in Flugrichtung, Kurvenlage und Neigung nach vorn aus der
 * Beschleunigung -- reine Pose. Kosmetik wie beim Kopf: den Zustand tragen
 * Ring und Hologramm. Alles in Weltkoordinaten; `k.base` ist die Hoehe der
 * Plattform darunter, `k.alt` die Flughoehe darueber (ohne die Schwebehoehe
 * des Modells, die figures.mjs beim Landen ausblendet). */
const KID_K = 7;            // 1/s²: Federkonstante zum Ziel
const KID_ZETA = 0.55;      // Daempfungsgrad unter 1: ueberschiesst ein wenig
const KID_VMAX = 38;        // Welteinheiten je Sekunde hoechstens
const KID_TURN = 5;         // rad/s
const ORBIT_R = 12;         // Kreisbahn um den Kopf (die Reihe lag KID_DROP = 13 davor)
const ORBIT_W = 0.7;        // rad/s
const ORBIT_ALT = 2;        // Flughoehe auf der Kreisbahn, wogt um ±1,2
const PROMPT_AHEAD = 5;     // vor dem Visier ...
const PROMPT_SIDE = 7;      // ... und seitlich daneben
const PROMPT_ALT = 3;
const PARK_NEAR = 3;        // naeher als das am Parkplatz: aufsetzen
const BANK = 0.03;          // rad je Welteinheit/s² Querbeschleunigung
const PITCH = 0.02;         // rad je Welteinheit/s Tempo
const TILT_MAX = 0.4;       // 0,5 legte eine herausgeschossene Drohne fast waagerecht (im Bild)

/* Ausfluege (working): ab und zu fliegt eine Drohne zu einem Bau oder zum
 * Commit-Band derselben Wabe, pendelt dort ein paar Sekunden davor und kommt
 * zurueck. Ziele liefert dieselbe Hindernisliste, der die Koepfe ausweichen
 * (obstaclesOf), nur in der Naehe des Kopfes, und je Kopf ist nur eine
 * Drohne zugleich unterwegs -- mit zwei draussen war im Bild nicht mehr zu
 * sehen, wem sie gehoeren. Kein Ausflug aus dem Hangar und keiner, solange
 * der Kopf zu einer anderen Wabe unterwegs ist. */
const TRIP_EVERY = [5, 11]; // Sekunden zwischen zwei Gelegenheiten
const TRIP_P = 0.65;        // Anteil der Gelegenheiten, die einen Ausflug starten
const TRIP_R = 45;          // so weit vom Kopf liegt ein Ziel hoechstens (60 war im Bild zu weit weg vom Kopf)
const TRIP_MAX_S = 12;      // Hinweg dauert laenger: aufgeben
const SCAN_S = [2.5, 4.5];  // Sekunden am Ziel
const SCAN_GAP = 5;         // Abstand zum Bau
const SCAN_W = 1.2;         // rad/s: Takt des Pendelns vor dem Bau
const SCAN_ARC = 1;         // rad Ausschlag zu jeder Seite
const SCAN_ALT = 5;
const SCAN_ARRIVE = 4;
// Herausschiessen einer neuen Drohne aus dem Rucksack
const POP_S = 0.7;          // Sekunden bis zur vollen Groesse
const POP_BACK = 2.5;       // Rucksack: so weit hinter der Kopfmitte
const POP_ALT = 3;          // ... und so hoch (plus Schwebehoehe = Rueckenmitte)
const POP_KICK = 14;        // Anfangstempo nach hinten und nach oben

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* Ein Ausflugsziel auf der Wabe, auf der der Kopf gerade steht, lokal zu ihr:
 * ein Bau (Kreis, r ist die gezeichnete Halbbreite, nicht der geschrumpfte
 * Sperrkreis) oder ein Punkt auf dem Commit-Band. */
function pickTrip(k, c, now) {
  const f = c.field;
  if (f.key === 'station') return null;
  const hx = c.x - f.w.x;
  const hz = c.z - f.w.z;
  const near = [];
  for (const o of f.obs) {
    const cell = o.cell ? f.cells[o.cell] : null;
    const ox = cell ? cell.dx : 0;
    const oz = cell ? cell.dz : 0;
    const spot = o.ax === undefined
      ? { x: o.x + ox, z: o.z + oz, r: o.r / OBS_SHRINK }
      : { x: o.ax + ox + (o.bx - o.ax) * Math.random(), z: o.az + oz, band: true };
    if (Math.hypot(spot.x - hx, spot.z - hz) < TRIP_R) near.push(spot);
  }
  if (!near.length) return null;
  const o = near[Math.floor(Math.random() * near.length)];
  return {
    ...o,
    key: f.key,
    a: Math.atan2(hz - o.z, hx - o.x), // Mitte des Bogens: die Seite, auf der der Kopf steht
    side: hz >= o.z ? 1 : -1,
    scanFrom: 0,
    until: now + TRIP_MAX_S * 1000,
  };
}

/* Ein Frame einer Drohne. `c` beschreibt ihren Kopf und ihren Platz:
 * { state, x, y, z, heading (Kopf, Weltkoordinaten), spin (Drehsinn der
 * Kreisbahn, je Kopf), parkX, parkY, parkZ, n, count (Platz unter den
 * gezeichneten Geschwistern), travel (Kopf unterwegs), field (Feld aus
 * figures.sync, auf dem der Kopf steht), away (ein Geschwister ist auf
 * Ausflug) }. */
function stepKid(k, c, dt, now) {
  const s = now / 1000;
  if (k.trip && (c.state === 'idle' || c.state === 'prompt')) k.trip = null;
  let tx;
  let tz;
  let ta;
  let ty = c.y;
  let face = null; // feste Blickrichtung, sonst Flugrichtung
  let land = 0;
  let scanning = false;
  if (c.state === 'idle') {
    tx = c.parkX;
    tz = c.parkZ;
    ty = c.parkY;
    // Hysterese: wer einmal aufsetzt, bleibt gelandet, auch wenn die Feder
    // ihn ein Stueck ueber den Platz hinaustraegt
    const d = Math.hypot(tx - k.x, tz - k.z);
    k.parked = d < (k.parked ? PARK_NEAR * 3 : PARK_NEAR);
    ta = k.parked ? 0 : ORBIT_ALT;
    if (k.parked) {
      face = 0; // zur Grundstellung der Kamera, wie der sitzende Kopf
      land = 1;
    }
  } else if (c.state === 'prompt') {
    // Schraeg vor das Visier, nicht genau davor: der Kopf schaut meist zur
    // Kamera, und eine Drohne direkt vor ihm verdeckte ihn ganz (im Bild
    // gesehen). Mehrere Fragende abwechselnd links und rechts, nach aussen
    // gestaffelt.
    const side = (c.n % 2 ? -1 : 1) * (PROMPT_SIDE + Math.floor(c.n / 2) * 7);
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    tx = c.x + fx * PROMPT_AHEAD + fz * side;
    tz = c.z + fz * PROMPT_AHEAD - fx * side;
    ta = PROMPT_ALT;
    face = Math.atan2(c.x - k.x, c.z - k.z);
  } else {
    // Ausflug abbrechen, sobald er nicht mehr passt: Zustand gewechselt, Kopf
    // unterwegs zu einer anderen Wabe, Zeit um
    if (k.trip && (c.travel || !c.field || c.field.key !== k.trip.key || now > k.trip.until)) {
      k.trip = null;
      k.nextTrip = now + rand(TRIP_EVERY) * 1000;
    }
    if (!k.trip && k.init && !c.travel && c.field && now >= k.nextTrip) {
      k.nextTrip = now + rand(TRIP_EVERY) * 1000;
      if (!c.away && Math.random() < TRIP_P) k.trip = pickTrip(k, c, now);
    }
    if (k.trip) {
      const tr = k.trip;
      const sx = c.field.w.x + tr.x;
      const sz = c.field.w.z + tr.z;
      const since = tr.scanFrom ? (now - tr.scanFrom) / 1000 : 0;
      if (tr.band) {
        // vor dem Commit-Band, auf der Seite des Kopfes, pendelt daran entlang
        tx = sx + Math.sin(since * SCAN_W) * 6;
        tz = sz + tr.side * (DAY_W / 2 + SCAN_GAP);
        face = Math.atan2(0, -tr.side);
      } else {
        // im Bogen vor dem Bau hin und her, auf der Seite des Kopfes. Ein
        // voller Kreis trug die Drohne bei einem Bau nahe der Kante ueber
        // den Plattformrand hinaus, der Ring hing dann in der Luft (im Bild).
        const a = tr.a + Math.sin(since * SCAN_W) * SCAN_ARC;
        tx = sx + Math.cos(a) * (tr.r + SCAN_GAP);
        tz = sz + Math.sin(a) * (tr.r + SCAN_GAP);
        face = Math.atan2(sx - k.x, sz - k.z);
      }
      ta = SCAN_ALT;
      if (!tr.scanFrom) {
        face = null; // auf dem Hinweg: Blick in Flugrichtung
        if (Math.hypot(tx - k.x, tz - k.z) < SCAN_ARRIVE) {
          tr.scanFrom = now;
          tr.until = now + rand(SCAN_S) * 1000;
        }
      } else {
        // Scan-Schimmer (figures.mjs): Ziel ist die Mitte des Baus, beim Band
        // der Balken direkt vor der Drohne. Der Strahl endet sichtbar an der
        // Fassade, weil er gegen die Tiefe gezeichnet wird; ein Ziel am Fuss
        // des Baus traf im Bild nur den Boden davor.
        scanning = true;
        k.scanX = tr.band ? k.x : sx;
        k.scanZ = sz;
      }
    } else {
      const a = c.spin * ORBIT_W * s + (Math.PI * 2 * c.n) / Math.max(1, c.count);
      const r = ORBIT_R + (c.n % 2) * 2.5;
      tx = c.x + Math.cos(a) * r;
      tz = c.z + Math.sin(a) * r;
      ta = ORBIT_ALT + Math.sin(s * 0.8 + c.n * 1.7) * 1.2;
    }
  }
  if (!k.init && k.pop < 1) {
    // Neu seit dem Laden der Seite: schiesst aus dem Rucksack des Kopfes,
    // nach hinten und hinauf, und waechst dabei auf seine Groesse (pop,
    // figures.mjs skaliert); die Feder holt die Drohne danach auf ihr Ziel.
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    k.x = c.x - fx * POP_BACK;
    k.z = c.z - fz * POP_BACK;
    k.alt = POP_ALT;
    k.base = c.y;
    k.vx = -fx * POP_KICK;
    k.vz = -fz * POP_KICK;
    k.va = POP_KICK;
    k.heading = c.heading + Math.PI;
    k.init = true;
  }
  if (!k.init) {
    // zum ersten Mal gesehen: gleich am Ziel, niemand fliegt nach dem Laden los
    k.x = tx;
    k.z = tz;
    k.alt = ta;
    k.base = ty;
    k.land = land;
    if (face !== null) k.heading = face;
    if (c.state === 'idle') {
      // steht schon auf dem Parkplatz, statt nach dem Laden erst zu landen
      k.parked = true;
      k.alt = 0;
      k.land = 1;
      k.heading = 0;
    }
    k.init = true;
  }
  const kk = KID_K * k.stiff;
  const cc = 2 * KID_ZETA * Math.sqrt(kk);
  const ax = kk * (tx - k.x) - cc * k.vx;
  const az = kk * (tz - k.z) - cc * k.vz;
  k.vx += ax * dt;
  k.vz += az * dt;
  const v = Math.hypot(k.vx, k.vz);
  if (v > KID_VMAX) {
    k.vx *= KID_VMAX / v;
    k.vz *= KID_VMAX / v;
  }
  k.x += k.vx * dt;
  k.z += k.vz * dt;
  k.va += (kk * (ta - k.alt) - cc * k.va) * dt;
  k.alt += k.va * dt;
  if (k.alt < 0) {
    k.alt = 0;
    if (k.va < 0) k.va = 0;
  }
  k.base += (ty - k.base) * Math.min(1, dt * 6);
  k.land += (land - k.land) * Math.min(1, dt * 3);
  k.scan += ((scanning ? 1 : 0) - k.scan) * Math.min(1, dt * 5);

  const speed = Math.hypot(k.vx, k.vz);
  const want = face ?? (speed > 3 ? Math.atan2(k.vx, k.vz) : k.heading);
  const d = wrap(want - k.heading);
  const step = KID_TURN * dt;
  k.heading = wrap(k.heading + (Math.abs(d) <= step ? d : Math.sign(d) * step));
  // Quer- und Laengsbeschleunigung im Blickrahmen der Drohne (rechts = +x lokal)
  const sin = Math.sin(k.heading);
  const cos = Math.cos(k.heading);
  const aSide = ax * cos - az * sin;
  const aFwd = ax * sin + az * cos;
  const e = Math.min(1, dt * 6);
  k.roll += (clamp(-aSide * BANK, -TILT_MAX, TILT_MAX) - k.roll) * e;
  const vFwd = k.vx * sin + k.vz * cos;
  k.pitch += (clamp(vFwd * PITCH + aFwd * 0.004, -0.25, TILT_MAX) - k.pitch) * e;
  k.gait = Math.min(1, speed / WALK);
  if (k.pop < 1) k.pop = Math.min(1, k.pop + dt / POP_S);
}

/* ---------- Registry ---------- */

const motion = new Map(); // Agenten-Key -> Bewegungszustand; ueberlebt Skin-Wechsel, nicht das Verschwinden des Agenten

/* Bewegungszustand eines Kopfes, neu angelegt beim ersten Frame: frisch =
 * Start im Hangar in Weltkoordinaten (Modus `travel`, Ziel ist der Heimplatz
 * auf der eigenen Wabe), sonst gleich am Heimplatz (lokal) mit einer ersten
 * Pause, damit nach dem Laden nicht alle gleichzeitig loslaufen.
 *
 * `home` ist die Wabe, auf der die Figur ihren Platz in der Anordnung hat,
 * `field` die, auf der sie gerade steht -- beim Anlegen dieselbe. */
function headMotion(key, fresh, hx, hz, stationW, now, home) {
  let m = motion.get(key);
  if (m) return m;
  // spin: Drehsinn der Kreisbahn seiner Drohnen, je Kopf gewuerfelt
  const base = { home, field: home, hx, hz, heading: 0, phase: 0, gait: 0, target: null, dest: null, lastD: Infinity, stuck: 0, seated: false, sit: 0, hop: null, spin: Math.random() < 0.5 ? -1 : 1 };
  m = fresh
    ? { ...base, mode: 'travel', x: stationW.x, y: stationW.y, z: stationW.z, dest: { key: home, x: hx, z: hz }, pauseUntil: 0 }
    : { ...base, mode: 'wander', x: hx, y: 0, z: hz, pauseUntil: now + rand([1, 6]) * 1000 };
  motion.set(key, m);
  return m;
}

/* `fresh`: seit dem Laden der Seite neu (freshKeys) -- dann startet die
 * Drohne im Rucksack mit pop 0, sonst ist sie schon ausgewachsen. */
function kidMotion(key, fresh) {
  let k = motion.get(key);
  if (k) return k;
  k = {
    mode: 'fly', init: false, x: 0, z: 0, alt: 0, base: 0, vx: 0, vz: 0, va: 0,
    heading: 0, pitch: 0, roll: 0, land: 0, gait: 0, parked: false, trip: null, nextTrip: 0,
    pop: fresh ? 0 : 1,
    scan: 0, scanX: 0, scanZ: 0, // Scan-Schimmer: Blend 0..1 und Zielpunkt (Welt)
    stiff: 0.85 + Math.random() * 0.3, // jede Drohne etwas anders straff
  };
  motion.set(key, k);
  return k;
}

/* Groesse beim Herausschiessen: 0 -> 1 mit einem kleinen Ueberschwinger
 * (easeOutBack), bei pop 1 exakt 1. */
function grown(k) {
  const x = k.pop - 1;
  return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
}

function forget(seen) {
  for (const key of motion.keys()) if (!seen.has(key)) motion.delete(key);
}

const motionOf = (key) => motion.get(key) ?? null;
const moving = () => motion.size > 0;

/* Welche Agenten sind seit dem letzten Frame neu? Hauptsessions laufen dann
 * vom Hangar los, Subagenten schiessen aus dem Rucksack ihres Kopfes (seit
 * 2026-09-16; vorher zaehlten nur Hauptsessions). Alle Keys des ganzen
 * State (alle Planeten, auch versteckte Felder) gelten danach als bekannt.
 * Der erste Aufruf nach dem Laden liefert nichts: was die Seite beim Start
 * vorfindet, hat seinen Weg schon hinter sich. Alte Sessions, die nur neu
 * ins Fenster des Collectors rutschen, sind an ageMinutes zu erkennen. */
const known = new Set();
let primed = false;
function freshKeys(state) {
  const fresh = new Set();
  for (const p of state?.planets ?? []) {
    for (const h of [p.station, ...p.hexes]) {
      for (const a of h.agents) {
        if (primed && !known.has(a.key) && a.ageMinutes <= NEW_MAX_AGE) fresh.add(a.key);
        known.add(a.key);
      }
    }
  }
  primed = true;
  return fresh;
}

export { MAX_DT, WALK, forget, freshKeys, grown, headMotion, kidMotion, motionOf, moving, obstaclesOf, stepKid, stepTravel, stepWander };
