/* Figuren: eine Kapsel je Agent in der Zustandsfarbe, Subagenten kleiner in
 * einer Reihe vor ihrem Kopf, Hologramm ueber wartenden und fragenden
 * Figuren. Form UND Farbe unterscheiden die beiden (Kasten gelb = wartet
 * auf mich, Kegel orange = Tool-Aufruf offen) — das "!" aus 2D fuer
 * Betrachter ohne Farbsehen. Ein kleiner Zeiger zur Figur (Kind-Mesh,
 * gleiches Material) macht aus dem Hologramm eine Sprechblase wie in 2D —
 * ohne ihn wirkt es wie ein schwebender Kasten (Nutzerfund im Bild).
 *
 * Die Anordnung sind die Formeln aus drawAgents() in agents.mjs, x/z statt
 * x/y — mit denselben hart erarbeiteten Abstaenden (zwei Anordnungen,
 * Deckel 5 bzw. 12, Kopfabstand aus der Kinderreihe). Beim Herausziehen
 * des Kerns zusammenlegen. Pool nach Agenten-Key, damit je Frame nichts
 * neu entsteht; jede Figur hat ihr eigenes Material, weil Deckkraft
 * (Scratchpad-Zuordnung) und Puls je Figur verschieden sind.
 *
 * Seit 2026-09-14 ist der Platz aus der Formel nur noch der Heimplatz:
 * motion.mjs laesst jeden Kopf langsam ueber seine ganze Wabe laufen, um
 * Bauten und Gelaende herum, und bei einem Projekt mit Sub-Repos auch auf
 * die Nachbarwaben derselben Familie hinueber (`m.field` sagt, wo eine Figur
 * gerade steht, `m.home`, wohin sie gehoert); eine neue Session laeuft einmal
 * vom Hangar her.
 * Kinder fliegen seit dem 2026-09-16 selbst (Kreisbahn, Visier, Parkplatz,
 * siehe motion.mjs::stepKid); idle sitzt auf dem Boden. Bewegungszustand liegt in motion.mjs (nach Key, ueberlebt den
 * Skin-Wechsel), hier liegen nur Meshes. Der Gang selbst: rig.mjs stellt
 * die Knochen des Astronauten nach der Phase, die Kapsel in clean neigt
 * sich und wippt.
 *
 * Bewusst nicht uebernommen (Plan, Abweichung 7): die Stiele zwischen Kopf
 * und Kindern — die Reihe direkt vor dem Kopf zeigt die Zugehoerigkeit.
 *
 * Kit-Skin (Task 7): Textur-Figuren (Klone aus skin.mjs) lassen sich nicht
 * ehrlich umfaerben, darum traegt ein Ring unter der Figur die
 * Zustandsfarbe statt der Kapsel selbst. Das Hologramm bleibt ueber beiden
 * Skins dasselbe Signal (Kasten = wartet, Kegel = fragt), pulst im Kit
 * aber emissiv statt ueber die Deckkraft eines unlit Materials. Groessen
 * kommen im Kit aus der Normierung in skin.mjs (role('figure')), nicht
 * mehr aus dem Aufrufer. */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ARC_R, ARC_R2, BUBBLE_STATES, KID_DROP, KID_GAP, SPREAD, byInterest, groupAgents } from '../agents.mjs';
import { cellsOf, rootOf } from '../hexmap.mjs';
import { COLORS, HEX, app } from '../store.mjs';
import * as bend from './bend.mjs';
import * as face from './face.mjs';
import * as motion from './motion.mjs';
import * as rig from './rig.mjs';
import * as skin from './skin.mjs';
import { cellWorldOf, drawnAgentsOf, live, worldOf } from './world.mjs';

const R_HEAD = 3;
const KID_SCALE = 0.65;
const BUBBLE_Y = 12 + 8; // ueber der Kapsel (Gesamthoehe 12: Mittelteil 6 plus zwei Radien)
const LEAN = 0.18;       // clean: Neigung der Kapsel in Laufrichtung
const CAP_BOB = 0.5;     // clean: Wippen je Schritt
const DRONE_BOB = 0.7;   // kit: Schweben der Kind-Drohne
// Sitzen auf dem Boden: die Figur sinkt um SIT_DROP, bis die Becken-
// Unterkante (Raycast am Modell in der Sitzhaltung, 2026-09-14) auf der
// Plattform liegt. Kein Stuhl mehr -- mit dem Rucksack sah das nicht gut
// aus (André), das Kenney-Modell ist wieder aus dem Kit.
const SIT_DROP = 2.08;
// Fuss bei y=0
const bodyGeo = new THREE.CapsuleGeometry(R_HEAD, 6, 4, 8).translate(0, R_HEAD + 3, 0);
// Kopf fehlt: hohler Kringel flach auf der Plattform, wie der gestrichelte Kreis in 2D.
// Dieselbe Geometrie traegt im Kit-Skin den Zustandsring unter einer Figur.
const ringGeo = new THREE.RingGeometry(3, 4.5, 16).rotateX(-Math.PI / 2);
const waitGeo = new THREE.BoxGeometry(8, 6, 1.5);
const promptGeo = new THREE.ConeGeometry(4, 8, 4);
waitGeo.computeBoundingBox();
promptGeo.computeBoundingBox();
// Zeiger zur Figur, wie der Schwanz an drawBubble() in 2D (dort: Platte 10
// hoch, Schwanz 4 -> rund 40 %; hier Kasten 6 hoch, Zeiger 2,5 -> rund ein
// Drittel). Kegel zeigt serienmaessig nach oben, rotateX dreht ihn um; danach
// so verschoben, dass der lokale Ursprung (y=0) die breite Grundflaeche ist —
// die Y-Position beim Formwechsel kommt aus der Unterkante der jeweils
// aktiven Geometrie (siehe bubble()), nicht aus einer festen Zahl.
const tailGeo = new THREE.ConeGeometry(1.5, 2.5, 4).rotateX(Math.PI).translate(0, -1.25, 0);

/* Trefferkoerper je Figur: ein unsichtbarer Kasten um sie herum, Ursprung am
 * Fuss. Warum nicht gegen den Koerper selbst gestrahlt wird: im Kit-Skin ist
 * die Figur ein Modell aus mehreren SkinnedMeshes, deren Raycasting teuer
 * und an den duennen Gliedern pixelgenau waere — ein Klick auf einen Arm
 * ginge daneben. Der Kasten ist eine Handbreit gross und trifft, was das Auge
 * meint. Geometrie und Material teilen sich alle Figuren, darum nie
 * disposen. */
const hitGeo = new THREE.BoxGeometry(9, 14, 9).translate(0, 7, 0);
const hitMat = new THREE.MeshBasicMaterial({ visible: false });

/* Scan-Schimmer (seit 2026-09-16): ein heller, flackernder Lichtkegel von
 * den Augen der Drohne zum Fuss des Baus, vor dem sie auf einem Ausflug
 * pendelt (motion.mjs, k.scan). Kosmetik, kein Signal -- darum keine Farbe
 * aus COLORS und nicht die Form des Hologramms (vierseitiger Kegel ueber der
 * Figur): rund, offen, blasses Cyan wie die Augen des Modells, additiv, mit
 * wandernden Streifen, und die Spitze am Ziel tastet quer hin und her.
 * Geometrie und Streifentextur teilen sich alle Strahlen. */
const BEAM_COLOR = 0x9fe8ff;
const BEAM_OPACITY = 0.5;
const BEAM_R = 2.2;        // Radius am Ziel
const BEAM_SWEEP = 3;      // Ausschlag des Ziels quer zum Strahl
const DRONE_EYE = 5;       // Augenhoehe der Drohne ueber ihrem Fusspunkt (Modell 8 hoch)
const BEAM_Y = 3;          // Zielhoehe ueber der Plattform, in der Mitte des Baus
// Spitze im Ursprung, Grundflaeche bei z = 1: lookAt() richtet +z aufs Ziel, scale.z ist die Laenge
const beamGeo = new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
let beamTex = null;
function beamTexture() {
  if (beamTex) return beamTex;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d');
  for (let y = 0; y < 64; y++) {
    const band = Math.pow(Math.sin((y / 64) * Math.PI * 4) * 0.5 + 0.5, 3);
    g.fillStyle = 'rgba(255,255,255,' + (0.3 + 0.7 * band).toFixed(3) + ')';
    g.fillRect(0, y, 4, 1);
  }
  beamTex = new THREE.CanvasTexture(c);
  beamTex.wrapT = THREE.RepeatWrapping;
  return beamTex;
}

let group = null;
const pool = new Map(); // key -> { body, bubble, tail, label, basic, model, modelKind, rig, ring, holo, holoColor }
let lastNow = null;

function mount(scene) {
  if (group) return;
  group = new THREE.Group();
  group.name = 'figures';
  scene.add(group);
}

function figure(key) {
  let f = pool.get(key);
  if (f) return f;
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 1, roughness: 0.6 }));
  const bubble = new THREE.Mesh(waitGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 }));
  bubble.visible = false;
  // Kind des Hologramms, gleiches Material: erbt Puls, Farbe und Skalierung
  // ohne eigene Zuweisung. Ueberlebt den Geometrie-Tausch in bubble(); die
  // Position dort wird beim Tausch aus der neuen Geometrie nachgezogen.
  const tail = new THREE.Mesh(tailGeo, bubble.material);
  tail.position.y = waitGeo.boundingBox.min.y;
  bubble.add(tail);
  const basic = bubble.material; // clean: unlit mit Deckkraft-Puls; kit tauscht auf ein emissives Material
  const el = document.createElement('span');
  el.className = 'cnt3d';
  const label = new CSS2DObject(el);
  label.visible = false;
  const hit = new THREE.Mesh(hitGeo, hitMat);
  group.add(body, bubble, label, hit);
  f = { body, bubble, tail, label, basic, hit, model: null, modelKind: null, rig: null, face: null, ring: null, holo: null, holoColor: null, beam: null };
  pool.set(key, f);
  return f;
}

/* Pulsierendes Hologramm, derselbe Puls wie drawBubble() in 2D. Clean pulst
 * die Deckkraft eines unlit Materials, kit die Leuchtstaerke eines
 * emissiven — die Form bleibt in beiden das Signal (Kasten = wartet,
 * Kegel = fragt). Das Kit-Material entsteht je Figur und Farbe einmal,
 * nicht je Frame. */
function bubble(f, state, x, y, z, s, t, seed) {
  if (!state || !BUBBLE_STATES.has(state)) {
    f.bubble.visible = false;
    return;
  }
  f.bubble.visible = true;
  const geo = state === 'prompt' ? promptGeo : waitGeo;
  f.bubble.geometry = geo;
  f.tail.position.y = geo.boundingBox.min.y;
  const color = COLORS.agent[state];
  const pulse = 0.6 + 0.4 * Math.sin(t / 380 + seed);
  if (skin.skin() === 'kit') {
    if (!f.holo || f.holoColor !== color) {
      f.holo?.dispose();
      f.holo = skin.role('hologramMaterial', color);
      f.holoColor = color;
    }
    f.bubble.material = f.holo;
    f.tail.material = f.bubble.material;
    f.holo.emissiveIntensity = pulse;
  } else {
    f.bubble.material = f.basic;
    f.tail.material = f.bubble.material;
    f.basic.color.set(color);
    f.basic.opacity = pulse;
  }
  f.bubble.position.set(x, y, z);
  f.bubble.scale.setScalar(s);
}

/* Ein Frame Scan-Schimmer einer Drohne: (x, y, z) sind ihre Augen, das Ziel
 * steht in k.scanX/k.scanZ in der Mitte des Baus. Unsichtbar, solange k.scan
 * ausgeblendet ist; das Mesh entsteht erst beim ersten Scan. */
function beam(f, k, x, y, z, t) {
  if (k.scan < 0.02) {
    if (f.beam) f.beam.visible = false;
    return;
  }
  if (!f.beam) {
    f.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: BEAM_COLOR, map: beamTexture(), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    group.add(f.beam);
  }
  const dx = k.scanX - x;
  const dz = k.scanZ - z;
  const d = Math.hypot(dx, dz) || 1;
  const sweep = Math.sin(t / 260) * BEAM_SWEEP;
  const tx = k.scanX - (dz / d) * sweep;
  const tz = k.scanZ + (dx / d) * sweep;
  const ty = k.base + BEAM_Y;
  f.beam.visible = true;
  f.beam.position.set(x, y, z);
  f.beam.lookAt(tx, ty, tz);
  f.beam.scale.set(BEAM_R, BEAM_R, Math.hypot(tx - x, ty - y, tz - z));
  f.beam.material.opacity = BEAM_OPACITY * k.scan * (0.8 + 0.2 * Math.sin(t / 45));
  beamTexture().offset.y = -t / 700;
}

/* Hoehe des Hologramms ueber der Plattform: clean ueber der Kapsel, kit ueber
 * dem normierten Modell (plus Schwebehoehe der Drohne). */
function bubbleY(kind, base) {
  const r = skin.role('figure', kind);
  if (r) return base + r.hover + r.height + 8;
  return base + (kind === 'sub' ? BUBBLE_Y * KID_SCALE : BUBBLE_Y);
}

/* Clean: Kapsel in der Zustandsfarbe. Kit: Klon des Modells (Textur, nicht
 * umfaerbbar) plus Leuchtring in der Zustandsfarbe darunter — die Farbe
 * wandert vom Koerper unter die Figur, das Signal bleibt. Die Groesse steckt
 * im Kit in der Normierung (main 12, sub 8), nicht im Aufrufer.
 *
 * Bewegung: `heading` dreht die Figur in Laufrichtung (Modell schaut nach
 * +z), `phase` und `gait` stellen den Gang (rig.mjs) bzw. Neigung und
 * Wippen der Kapsel; die Drohne schwebt mit `t`. Der Ring bleibt flach auf
 * der Plattform. */
/* Der Trefferkasten laeuft mit der gezeichneten Figur mit — mit ihrer
 * Position, nicht mit ihrem Heimplatz: wer die laufende Figur anklickt, will
 * sie treffen, wo sie steht. Die Senkung der gekruemmten Welt macht der
 * Strahl in pick.mjs, wie bei Plattformen und Tagesbauten. */
function placeHit(f, pos, s) {
  f.hit.position.copy(pos);
  f.hit.scale.setScalar(s);
}

function body(f, a, x, y, z, scale, kind, heading, phase, gait, t, seed = 0, sit = 0, kid = null) {
  const r = skin.role('figure', kind);
  if (r) {
    if (!f.model || f.modelKind !== kind) {
      if (f.model) {
        group.remove(f.model);
        disposeSkeletons(f.model); // jeder Klon hat sein eigenes Skelett -> eigene boneTexture
      }
      f.model = r.make();
      f.baseScale = f.model.scale.x; // die Normierung aus make(), siehe unten
      f.modelKind = kind;
      f.rig = kind === 'main' ? rig.attach(f.model) : null;
      f.face = kind === 'main' ? face.attach(f.model) : null; // Kind am Modell, verschwindet mit ihm
      f.model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false; // Figuren wandern mit der Umordnungsfahrt
      });
      group.add(f.model);
    }
    f.body.visible = false;
    f.model.visible = true;
    let lift = 0;
    if (f.rig) {
      rig.pose(f.rig, phase, gait, sit);
      lift = rig.bob(phase, gait);
      if (f.face) face.update(f.face, a.state, sit, t);
    } else if (kind === 'sub') {
      // gelandet schwebt nichts mehr: Wippen und Schwebehoehe blenden aus
      lift = DRONE_BOB * Math.sin(t / 520 + seed) * (1 - (kid?.land ?? 0));
    }
    const hover = kid ? r.hover * (1 - kid.land) : r.hover;
    f.model.position.set(x, y + hover + lift - SIT_DROP * sit, z);
    // Drohne: Neigung nach vorn und Kurvenlage im eigenen Rahmen (erst Blick, dann Nicken, dann Rollen)
    if (kid) {
      f.model.rotation.set(kid.pitch, heading, kid.roll, 'YXZ');
      // Herauswachsen aus dem Rucksack: auf die Normierung aus make(), nie statt ihrer
      f.model.scale.setScalar(f.baseScale * motion.grown(kid));
    } else {
      f.model.rotation.y = heading;
    }
    // Kein scale.setScalar(1) hier: make() liefert den Klon schon skaliert
    // (Zielhoehe / gebackene Hoehe) -- der Mechanismus fuer "eine Datei,
    // zwei Rollen mit unterschiedlicher Hoehe" (Review Task 7, Fund 2).
    if (!f.ring) {
      f.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, side: THREE.DoubleSide }));
      group.add(f.ring);
    }
    f.ring.visible = true;
    f.ring.material.color.set(COLORS.agent[a.state] ?? COLORS.agent.idle);
    // Blass = ueber die Scratchpad-Kodierung zugeordnet (wie 2D, dort der Punkt; clean der Koerper)
    f.ring.material.opacity = a.scratchpad ? 0.62 : 1;
    // Der Ring bleibt auf der Plattform, auch unter einer fliegenden Drohne
    f.ring.position.set(x, (kid ? y - kid.alt : y) + 0.4, z);
    f.ring.scale.setScalar(kind === 'sub' ? 0.7 * (kid ? motion.grown(kid) : 1) : 1);
    placeHit(f, f.model.position, kind === 'sub' ? 0.7 : 1);
    return;
  }
  if (f.model) f.model.visible = false;
  if (f.ring) f.ring.visible = false;
  f.body.visible = true;
  f.body.geometry = bodyGeo;
  f.body.material.color.set(COLORS.agent[a.state] ?? COLORS.agent.idle);
  // Blass = ueber die Scratchpad-Kodierung zugeordnet, nicht ueber einen echten cwd (wie 2D)
  f.body.material.opacity = a.scratchpad ? 0.62 : 1;
  // Die Kapsel hat keine Vorderseite: sie neigt sich in Laufrichtung und wippt je Schritt
  f.body.position.set(x, y + CAP_BOB * Math.abs(Math.sin(phase)) * gait, z);
  f.body.rotation.set(LEAN * gait * Math.cos(heading), 0, -LEAN * gait * Math.sin(heading));
  f.body.scale.setScalar(scale * (kid ? motion.grown(kid) : 1));
  placeHit(f, f.body.position, scale);
}

function placeField(field, agents, seen, env) {
  const { h, w } = field;
  const { now: t, dt } = env;
  const isStation = h === env.station;
  // Die Familie dieses Feldes: dorthin darf eine Figur hinuebergehen
  const kin = isStation ? [field] : (env.kinOf.get(env.rootOf(h)) ?? [field]);
  const all = groupAgents(agents);
  const hasKids = all.some((g) => g.kids.length);
  if (hasKids) all.sort(byInterest);
  const groups = all.slice(0, hasKids ? 5 : 12);
  const rest = all.length - groups.length;
  const kidCap = groups.length > 2 ? 3 : 6;
  const kidRow = (kidCap - 1) * KID_GAP + 2 * 4.2;
  const pitch = Math.max(30, kidRow + 6);
  let lastOuterX = null;

  groups.forEach((g, i) => {
    let dx;
    let dz;
    if (hasKids) {
      const n = groups.length;
      const spread = Math.min(SPREAD, (n - 1) * pitch);
      dx = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread;
      dz = HEX * 0.11;
    } else {
      const row = i < 6 ? 0 : 1;
      const inRow = row === 0 ? Math.min(groups.length, 6) : groups.length - 6;
      const k = row === 0 ? i : i - 6;
      const t0 = inRow === 1 ? 0.5 : k / (inRow - 1);
      const ang = Math.PI * (0.12 + 0.76 * t0);
      const rad = row === 0 ? ARC_R : ARC_R2;
      dx = rad * Math.cos(ang);
      dz = rad * Math.sin(ang) * 0.62 + HEX * 0.1;
    }
    // Heimplatz (Formel) in Weltkoordinaten; die Zeichenposition weicht davon ab, sobald die Figur laeuft
    const hx = w.x + dx;
    const hz = w.z + dz;
    let px = hx;
    let py = w.y;
    let pz = hz;
    let heading = 0;
    let phase = 0;
    let gait = 0;
    const drawn = g.kids.slice(0, kidCap);
    if (hasKids && i === groups.length - 1) {
      lastOuterX = hx + Math.max(g.head ? 5 : 4.5, drawn.length ? ((drawn.length - 1) / 2) * KID_GAP + 4.2 : 0);
    }

    // Gruppen ohne Kopf haben keinen Key — der Ort ist ihr Schluessel
    const key = g.head ? g.head.key : 'orphans:' + hx.toFixed(0) + ':' + hz.toFixed(0);
    const f = figure(key);
    seen.add(key);
    // Klickbar ist nur, was auch eine Zeile im Panel hat: eine Hauptsession
    // auf einem Feld. Gruppen ohne Kopf, der "+N"-Zaehler und alles im
    // Hangar bleiben aussen vor — dahinter steht kein Panel.
    f.hit.visible = Boolean(g.head) && !isStation;
    f.hit.userData = g.head ? { key, hexId: h.id } : {};
    let m = null;
    let cur = field; // die Wabe, auf der der Kopf gerade steht
    if (g.head) {
      m = motion.headMotion(key, env.fresh.has(key) && !isStation, dx, dz, env.stationW, t, field.key);
      m.hx = dx;
      m.hz = dz;
      // Die Wabe, auf der die Figur gerade steht — nicht zwingend ihre
      // eigene. Ist sie verschwunden (Familie zugeklappt), holt der Rueckfall
      // sie nach Hause.
      let here = env.byId.get(m.field);
      if (!here) {
        here = field;
        m.field = field.key;
      }
      if (m.mode === 'travel') {
        motion.stepTravel(m, dt, t, env.fields, env.byId);
      } else {
        motion.stepWander(m, dt, t, g.head.state, here, env.heads, kin);
      }
      env.heads.push(m);
      // Nach dem Schritt erneut nachschlagen: stepTravel kann in diesem Frame
      // angekommen sein, stepWander aufgebrochen.
      cur = env.byId.get(m.field) ?? field;
      if (m.mode === 'travel') {
        px = m.x;
        py = m.y;
        pz = m.z;
      } else {
        px = cur.w.x + m.x;
        py = cur.w.y;
        pz = cur.w.z + m.z;
      }
      heading = m.heading;
      phase = m.phase;
      gait = m.gait;
      body(f, g.head, px, py, pz, 1, 'main', heading, phase, gait, t, 0, m.sit);
      bubble(f, g.head.state, px, bubbleY('main', py), pz, 1, t, i);
    } else {
      if (f.model) f.model.visible = false;
      if (f.ring) f.ring.visible = false;
      f.body.visible = true;
      f.body.geometry = ringGeo;
      f.body.material.color.set('#e6edf3');
      f.body.material.opacity = 0.45;
      f.body.position.set(hx, w.y + 0.5, hz);
      f.body.rotation.set(0, 0, 0);
      f.body.scale.setScalar(1);
      f.bubble.visible = false;
    }
    // Der Zaehler traegt die Wahrheit — gezeichnet werden hoechstens kidCap Kinder
    f.label.visible = g.kids.length > 0;
    if (f.label.element.classList.contains('rest')) f.label.element.classList.remove('rest');
    if (g.kids.length) {
      const txt = String(g.kids.length);
      if (f.label.element.textContent !== txt) f.label.element.textContent = txt;
      bend.place(f.label, px + 6, py + 14, pz); // DOM-Label: Kruemmung von Hand, siehe bend.mjs
    }

    // Kinder: fliegen selbst (motion.mjs::stepKid) -- Kreisbahn um den Kopf,
    // vor sein Visier oder auf den Parkplatz. Der Parkplatz ist die alte
    // Reihe vor dem Heimplatz, auf der Heimwabe.
    drawn.forEach((k, n) => {
      const kf = figure(k.key);
      seen.add(k.key);
      kf.hit.visible = !isStation;
      kf.hit.userData = { key: k.key, hexId: isStation ? null : h.id };
      const km = motion.kidMotion(k.key, env.fresh.has(k.key) && !isStation);
      motion.stepKid(km, {
        state: k.state, x: px, y: py, z: pz, heading, spin: m?.spin ?? 1,
        travel: m?.mode === 'travel', field: cur,
        away: drawn.some((o) => o !== k && motion.motionOf(o.key)?.trip),
        parkX: hx + (n - (drawn.length - 1) / 2) * KID_GAP, parkY: w.y, parkZ: hz + KID_DROP,
        n, count: drawn.length,
      }, dt, t);
      const ky = km.base + km.alt;
      body(kf, k, km.x, ky, km.z, KID_SCALE, 'sub', km.heading, 0, km.gait, t, i * 7 + n, 0, km);
      // Augen: Kit-Modell oder clean-Kapsel, ein Stueck vor der Mitte in Blickrichtung
      const kitKid = Boolean(kf.model?.visible);
      const eye = kitKid ? kf.model.position : kf.body.position;
      beam(kf, km, eye.x + Math.sin(km.heading) * 1.5, eye.y + (kitKid ? DRONE_EYE : 5) * motion.grown(km), eye.z + Math.cos(km.heading) * 1.5, t);
      kf.label.visible = false;
      // Nur prompt, nie waiting: Kinder wartet ihr Parent ab (Collector)
      bubble(kf, k.state === 'prompt' ? 'prompt' : null, km.x, bubbleY('sub', ky), km.z, 0.7, t, i * 7 + n);
    });
  });

  // "+N" fuer abgeschnittene Gruppen, relativ zum letzten Cluster wie in 2D
  if (rest > 0) {
    const key = 'rest:' + w.x.toFixed(0) + ':' + w.z.toFixed(0);
    const f = figure(key);
    seen.add(key);
    f.hit.visible = false; // der "+N"-Zaehler ist Text, keine Figur
    if (f.model) f.model.visible = false;
    if (f.ring) f.ring.visible = false;
    f.body.visible = false;
    f.bubble.visible = false;
    f.label.visible = true;
    f.label.element.classList.add('rest');
    const txt = '+' + rest;
    if (f.label.element.textContent !== txt) f.label.element.textContent = txt;
    const rx = hasKids && lastOuterX !== null ? lastOuterX + 8 : w.x + HEX * 0.62;
    bend.place(f.label, rx, w.y + 6, w.z + HEX * 0.11);
  }
}

/* Jeder Klon aus SkeletonUtils.clone() traegt sein eigenes Skeleton, und
 * three legt je Skeleton eine eigene boneTexture an (GPU-Textur). Geometrie
 * und Material des Modells gehoeren kit.mjs (kein dispose() darauf), aber
 * das Skeleton gehoert dem Klon selbst -- ohne dispose() haeuft sich eine
 * Textur je Skin-Wechsel oder verschwundenem Agenten an (gemessen: 22 -> 232
 * ueber 20 Wechsel, Speicher blieb auch nach dem Verschwinden der Agenten
 * oben). Skeleton.dispose() existiert in three 0.186 (geprueft im Quelltext:
 * `node_modules/three/src/objects/Skeleton.js`, gibt `boneTexture` frei). */
function disposeSkeletons(model) {
  model.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
  });
}

function drop(f) {
  group.remove(f.body, f.bubble, f.label, f.hit); // hitGeo/hitMat sind geteilt, kein dispose
  if (f.model) {
    group.remove(f.model); // Geometrie und Material gehoeren kit.mjs: kein dispose() darauf
    disposeSkeletons(f.model);
  }
  if (f.ring) {
    group.remove(f.ring);
    f.ring.material.dispose();
  }
  if (f.beam) {
    group.remove(f.beam); // beamGeo und die Streifentextur sind geteilt
    f.beam.material.dispose();
  }
  f.label.element.remove(); // der CSS2DRenderer raeumt fremde Elemente nicht ab
  f.body.material.dispose();
  f.basic.dispose();
  f.holo?.dispose();
}

function sync(p, idx, now) {
  // Zeitschritt seit dem letzten Frame, gedeckelt: nach einer Pause (Tab
  // versteckt, 2D-Modus) laufen die Figuren weiter, statt zu springen.
  const dt = lastNow === null ? 0 : Math.min(motion.MAX_DT, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  const kit = skin.skin() === 'kit';
  const fields = [];
  for (const h of [p.station, ...p.hexes]) {
    if (h !== p.station && h.hidden) continue;
    const w = worldOf(h, idx, now);
    /* Die begehbare Flaeche als Zellmittelpunkte relativ zur Hauptzelle: ein
     * Projekt belegt seit den Mehrfach-Waben bis zu fuenf. Je Frame neu
     * gerechnet, weil cellCenter waehrend einer Umordnungsfahrt
     * interpoliert. */
    const cells = cellsOf(h).map((c) => {
      const cw = cellWorldOf(h, c, idx, now);
      return { dx: cw.x - w.x, dz: cw.z - w.z };
    });
    fields.push({ key: h.id ?? 'station', h, w, cells: cells.length ? cells : [{ dx: 0, dz: 0 }], obs: motion.obstaclesOf(h, h === p.station, kit) });
  }
  const byId = new Map(fields.map((f) => [f.key, f]));
  /* Wer darf zu wem hinueber: die sichtbaren Felder je Familie, ueber die
   * Wurzel gruppiert (hexmap.rootOf, dasselbe Kriterium wie Silhouette und
   * Hubstufe). Eine zugeklappte Familie zeigt nur ihren Container — dann ist
   * die Liste einelementig und niemand geht auf Wanderschaft. Der Hangar
   * gehoert zu keiner Familie. */
  const kinOf = new Map();
  for (const f of fields) {
    if (f.h === p.station) continue;
    const r = rootOf(f.h, idx).id;
    if (!kinOf.has(r)) kinOf.set(r, []);
    kinOf.get(r).push(f);
  }
  const env = {
    now, dt, kit, fields, byId, kinOf, station: p.station, stationW: fields[0].w,
    fresh: motion.freshKeys(app.state),
    // Koepfe aller Felder dieses Frames; separate() filtert auf dieselbe
    // Plattform, weil Figuren inzwischen ueber Wabengrenzen laufen.
    heads: [],
    rootOf: (h) => rootOf(h, idx).id,
  };
  const seen = new Set();
  for (const field of fields) {
    const agents = field.h === p.station ? live(p.station.agents) : drawnAgentsOf(field.h, idx);
    if (!agents.length) continue;
    placeField(field, agents, seen, env);
  }
  for (const [key, f] of pool) {
    if (seen.has(key)) continue;
    drop(f);
    pool.delete(key);
  }
  motion.forget(seen);
}

/* Skin-Wechsel: den ganzen Pool verwerfen; der naechste sync() baut jede
 * Figur mit role() neu. Billiger als Klone und Kapseln je Figur zu tauschen.
 * Der Bewegungszustand bleibt (motion.mjs): niemand springt zurueck. */
function rebuild() {
  for (const f of pool.values()) drop(f);
  pool.clear();
}

function unmount() {}

/* Was ein Strahl treffen darf. Unsichtbare Kaesten ueberspringt der
 * Raycaster von sich aus (object.visible), die Liste bleibt trotzdem kurz. */
const hitObjects = () => [...pool.values()].map((f) => f.hit).filter((m) => m.visible);
const poolSize = () => pool.size;
const animating = () => motion.moving();
const figureOf = (key) => pool.get(key) ?? null; // fuer Szenarien

export { animating, figureOf, hitObjects, mount, poolSize, rebuild, sync, unmount };
