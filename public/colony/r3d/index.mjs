/* Die 3D-Fassade: dieselben Exporte wie r2d/index.mjs, dahinter three.js.
 * Ein Frame = alle Module auf den Planeten abgleichen, dann rendern. Frames
 * gibt es nur auf Anlass (Poll, Kamera, Fahrt, Puls) — dieselbe Regel wie
 * tick() in map.mjs, aus demselben Grund: CPU in jedem offenen Tab. */

import { BUBBLE_STATES } from '../agents.mjs';
import { hideDayTip, showDayTip } from '../daytip.mjs';
import { index } from '../hexmap.mjs';
import { COLORS, app, frameGap, planet } from '../store.mjs';
import * as bend from './bend.mjs';
import * as builds from './builds.mjs';
import * as cam from './camera.mjs';
import * as figures from './figures.mjs';
import * as ground from './ground.mjs';
import * as labels from './labels.mjs';
import * as pick from './pick.mjs';
import * as scene from './scene.mjs';
import * as skin from './skin.mjs';
import * as sky from './sky.mjs';
import * as tiles from './tiles.mjs';
import { drawnAgentsOf, lifting, live } from './world.mjs';

const el = (id) => document.getElementById(id);
let mounted = false;

function mount() {
  const canvas = el('colony3d');
  const overlay = el('overlay3d');
  canvas.hidden = false;
  overlay.hidden = false;
  scene.mount(canvas, overlay);
  cam.initControls(canvas, onCameraChange);
  tiles.mount(scene.scene);
  builds.mount(scene.scene);
  figures.mount(scene.scene);
  labels.mount(scene.scene);
  ground.mount(scene.scene);
  sky.onLoad(requestDraw); // ein Himmelbild ist da: ein Frame, statt auf den naechsten Poll zu warten
  // Skin-Haken: jedes Modul verwirft bei einem Wechsel seine Meshes, dann
  // ein Frame. Der Knopf im HUD haengt an app.setSkin wie app.reorder -- hud.mjs
  // darf r3d nicht importieren, sonst laedt jeder 2D-Nutzer three.
  for (const m of [tiles, builds, figures, scene, ground]) skin.onRebuild(m.rebuild);
  app.setSkin = skin.setSkin;
  app.skin = skin.skin;
  skin.initSkin({ onChange: () => { requestDraw(); app.refreshHud?.(); } }); // async, wirft nie; clean zeichnet solange
  listen(canvas);
  mounted = true;
}

function unmount() {
  mounted = false;
  cam.cancelAnim();
  // Zeigerzustand ist geteilt (store.mjs): ohne das leckt ein Hover aus 3D
  // nach 2D, ohne dass sich die Maus bewegt (Review Task 6, R15).
  app.hover = null;
  app.chipHover = null;
  hideDayTip();
  delete app.setSkin;
  delete app.skin;
  el('colony3d').hidden = true;
  el('overlay3d').hidden = true;
}

/* Zeiger auf dem 3D-Canvas. OrbitControls nimmt Ziehen und Rad; ein Klick
 * ist ein pointerup ohne Bewegung dazwischen (unter 4 px), sonst war es
 * eine Kamerafahrt. Der Doppelklick-Handel aus 2D gilt unveraendert: zwei
 * pointerup feuern mit, die Wabe wird zweimal ausgewaehlt, kein Timer. */
let listening = false;
let down = null;

function listen(canvas) {
  if (listening) return;
  listening = true;
  canvas.addEventListener('pointerdown', (e) => {
    cam.cancelAnim(); // Hand am Bild schlaegt den Tween
    hideDayTip();
    down = { x: e.clientX, y: e.clientY, moved: false };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) down.moved = true;
    if (down?.moved) return; // waehrend einer Kamerafahrt kein Hover
    const h = pick.pickHex(e.clientX, e.clientY);
    if (h?.id !== app.hover?.id) {
      app.hover = h;
      requestDraw();
    }
    // Zeiger ueber einer Figur, wie in 2D
    canvas.style.cursor = pick.pickAgent(e.clientX, e.clientY) ? 'pointer' : '';
    const d = pick.pickDay(e.clientX, e.clientY);
    if (d?.hex.id !== app.dayHover?.hexId || d?.day !== app.dayHover?.day) {
      if (d) {
        app.dayHover = { hexId: d.hex.id, day: d.day };
        showDayTip(d);
      } else {
        hideDayTip();
      }
      requestDraw();
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (app.hover) {
      app.hover = null;
      requestDraw();
    }
    if (app.dayHover) {
      hideDayTip();
      requestDraw();
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    const moved = down?.moved;
    down = null;
    if (moved) return; // Drehen oder Schieben ist kein Klick
    // Die Figur schlaegt die Plattform, wie in 2D: sie steht darauf, und wer
    // sie trifft, meint sie.
    const a = pick.pickAgent(e.clientX, e.clientY);
    if (a && app.clickAgent?.(a)) return;
    app.clickHex?.(pick.pickHex(e.clientX, e.clientY));
  });
  canvas.addEventListener('dblclick', (e) => {
    const h = pick.pickHex(e.clientX, e.clientY);
    if (h) cam.focusHex(h);
    else cam.animateFit(); // ins Leere, auch auf den Hangar: zurueck zur Uebersicht
  });
}

/* Ein Frame auf Anlass, zusammengefasst: drei Kamera-Events in einem Tick
 * sind ein Frame, nicht drei. */
let queued = false;
function requestDraw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame((t) => {
    queued = false;
    draw(t);
  });
}

function onCameraChange() {
  hideDayTip();
  requestDraw();
}

function draw(now = performance.now()) {
  if (!mounted) return;
  const p = planet();
  if (p) {
    scene.scene.background.set(COLORS.planet[p.theme] ?? '#0d1117');
    scene.setShadows(app.state?.config?.shadows !== false); // Config `shadows`, wirkt ab dem naechsten Poll
    scene.syncPixelRatio(); // Config `maxPixelRatio3d`, ebenso
    const idx = index(p.hexes);
    cam.syncLimits(now); // Zoom-Deckel auf die sichtbare Kolonie, vor bend.sync: eine Heranfahrt bewegt das Ziel nicht, aber der Abstand zaehlt
    bend.sync(cam.getControls().target); // Scheitel der Kruemmung = Kameraziel, vor den Modulen (Labels rechnen damit)
    tiles.sync(p, idx, now);
    builds.sync(p, idx, now);
    ground.sync(p, idx, now);
    figures.sync(p, idx, now);
    labels.sync(p, idx, now);
    if (lifting(now) || tiles.animating(now)) scheduleTick(); // Hubfahrt und ausfahrende Stege: Frames, solange etwas faehrt
  }
  scene.render();
}

function resize() {
  scene.resize();
  draw();
}

function fitView() {
  cam.fitView();
  requestDraw();
}

const focusHex = (h) => cam.focusHex(h);
const cancelAnim = () => cam.cancelAnim();

let tickQueued = false;
let lastTick = -Infinity; // Zeitstempel des letzten gezeichneten Animations-Frames

function scheduleTick() {
  if (tickQueued) return;
  tickQueued = true;
  requestAnimationFrame(tick);
}

/* Kopie der tick-Kette aus map.mjs: Fahrt beenden, wenn ihre Zeit um ist;
 * weiterlaufen nur, solange etwas pulsiert, das auch zu sehen ist. */
function tick(t) {
  tickQueued = false;
  if (!mounted) return;
  // Config maxFps, wie in map.mjs: nur diese Kette wird gedrosselt. Kamera-
  // Drehen, Zoomen und Fahrten zeichnen ueber requestDraw() und bleiben
  // fluessig; motion.mjs rechnet mit dt, die Figuren laufen gleich schnell.
  if (t - lastTick < frameGap()) {
    scheduleTick();
    return;
  }
  lastTick = t;
  const m = app.move;
  const moving = m && t - m.t0 < m.ms;
  if (m && !moving) {
    app.move = null;
    for (const pl of app.state?.planets ?? []) for (const h of pl.hexes) { delete h.fromX; delete h.fromY; }
  }
  const p = planet();
  const idx = p ? index(p.hexes) : null;
  const pulsing =
    p && [...p.hexes.flatMap((h) => drawnAgentsOf(h, idx)), ...live(p.station.agents)].some((a) => BUBBLE_STATES.has(a.state));
  draw(t);
  // Seit 2026-09-14 laufen die Figuren (figures.mjs, motion.mjs): solange es
  // welche gibt, gibt es Frames. Das ist die eine bewusste Ausnahme von
  // "Frames nur auf Anlass" -- in einem versteckten Tab drosselt der Browser
  // requestAnimationFrame selbst, und motion.mjs deckelt dt gegen Spruenge.
  if (pulsing || moving || figures.animating()) scheduleTick();
}

const pickHex = (sx, sy) => pick.pickHex(sx, sy);
const pickDay = (sx, sy) => pick.pickDay(sx, sy);
function pickChip() { return null; } // der Chip ist DOM (labels.mjs) und klickt sich selbst

/* Anker fuer eine offene Tages-Card nach dem Poll: der Slot des Tages,
 * projiziert. Kein Slot (Feld versteckt, keine Commits mehr) = null. */
function dayAnchor(h, day) {
  const slot = builds.slotOf(h.id, day);
  return slot ? { hex: h, day, rect: pick.rectOf(slot) } : null;
}

export {
  cancelAnim, dayAnchor, draw, fitView, focusHex, mount, pickChip, pickDay, pickHex,
  requestDraw, resize, scheduleTick, unmount,
};
