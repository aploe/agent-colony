/* Text als DOM-Overlay (CSS2DRenderer): Titel und Statuszeile schweben
 * ueber jeder Plattform, der Chip sitzt am Westrand. Textinhalt ueber
 * textContent, nie innerHTML — kein Escaping noetig, kein Weg fuer Markup.
 * Pool nach Feld-ID; verschwindet ein Feld, geht auch sein Element aus
 * dem DOM, der CSS2DRenderer raeumt das nicht selbst ab.
 *
 * Der Chip ist das einzige Overlay mit pointer-events (colony.css) und
 * loest denselben Weg aus wie der Chip auf der 2D-Karte: app.toggleFamily.
 *
 * Positionen gehen ueber bend.place(): der CSS2DRenderer projiziert die
 * flache Weltposition, die Kruemmung (bend.mjs) kennt er nicht. */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { CHIP_DX } from '../collapse.mjs';
import { descendantsOf } from '../hexmap.mjs';
// Namensraum statt `t`: `t` ist hier lokal der Titel-Span (siehe setText).
import * as i18n from '../i18n.mjs';
import { HEX, app } from '../store.mjs';
import * as bend from './bend.mjs';
import { live, worldOf } from './world.mjs';

const LABEL_Y = 22;           // Schwebehoehe ueber der Oberkante
const LABEL_DZ = -HEX * 0.45; // Nordseite, ueber dem Skyline-Band (Platzordnung im Plan)

let group = null;
const labels = new Map(); // Feld-ID oder 'station' -> CSS2DObject
const chips = new Map();  // Container-ID -> CSS2DObject

function mount(scene) {
  if (group) return;
  group = new THREE.Group();
  group.name = 'labels';
  scene.add(group);
}

function label(key, station) {
  let o = labels.get(key);
  if (o) return o;
  const el = document.createElement('div');
  el.className = 'lbl3d' + (station ? ' station' : '');
  const t = document.createElement('span');
  t.className = 't';
  const s = document.createElement('span');
  s.className = 's';
  el.append(t, s);
  o = new CSS2DObject(el);
  o.center.set(0.5, 1); // Unterkante am Anker: der Text schwebt ueber dem Punkt
  group.add(o);
  labels.set(key, o);
  return o;
}

function chip(h) {
  let o = chips.get(h.id);
  if (o) return o;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'chip3d';
  el.title = i18n.t('map.chipTitle');
  el.onclick = (e) => {
    e.stopPropagation();
    app.toggleFamily?.(h.id);
  };
  el.onpointerenter = () => { app.chipHover = h.id; };
  el.onpointerleave = () => { app.chipHover = null; };
  o = new CSS2DObject(el);
  // Der CSS2DRenderer sortiert nach renderOrder, dann nach Kameradistanz.
  // Ohne das lag der Chip auf einem dichten Planeten zur Haelfte unter dem Titel des naeheren
  // Nachbarn. Der Chip ist ein Klickziel und liegt ueber jedem Titel.
  o.renderOrder = 1;
  group.add(o);
  chips.set(h.id, o);
  return o;
}

/* Nur schreiben, was sich geaendert hat: seit die Figuren laufen, kommt
 * sync() je Frame, und jede textContent-Zuweisung wuerde einen Textknoten
 * ersetzen und Layout ausloesen -- 60-mal je Sekunde fuer 30 Felder. */
function setText(o, title, status) {
  const t = o.element.firstChild;
  const s = o.element.lastChild;
  if (t.textContent !== title) t.textContent = title;
  if (s.textContent !== status) s.textContent = status;
}

function sync(p, idx, now) {
  const seen = new Set();
  const seenChips = new Set();

  const sw = worldOf(p.station, idx, now);
  const st = label('station', true);
  // Zahl wie in 2D: sie beschreibt die Figuren darunter, also nur laufende Sessions
  setText(st, i18n.t('map.station'), i18n.t('map.strays', { n: live(p.station.agents).length }));
  bend.place(st, sw.x, sw.y + LABEL_Y, sw.z + LABEL_DZ);
  st.visible = true;
  seen.add('station');

  for (const h of p.hexes) {
    const o = label(h.id, false);
    seen.add(h.id);
    o.visible = !h.hidden;
    if (h.hidden) continue;
    const w = worldOf(h, idx, now);
    // Dieselbe Statuszeile wie drawStatus() in map.mjs; `state: null` heisst
    // nur "kein Transkript", nicht "kein Agent hier"
    setText(
      o,
      h.title,
      h.state === null
        ? i18n.t('map.noTranscript')
        : i18n.t('map.hexStatus', { sessions: h.sessions.total, days: h.daysSinceActivity }),
    );
    bend.place(o, w.x, w.y + LABEL_Y, w.z + LABEL_DZ);
    if (h.satellites) {
      const c = chip(h);
      seenChips.add(h.id);
      // Der Chip zaehlt, was er versteckt: alle Nachkommen, nicht nur die direkten Kinder
      const txt = (app.collapsed.has(h.id) ? '+' : '−') + descendantsOf(h.id, idx).length;
      if (c.element.textContent !== txt) c.element.textContent = txt;
      bend.place(c, w.x + CHIP_DX, w.y + 4, w.z);
      c.visible = true;
    }
  }

  for (const [id, o] of labels) {
    if (seen.has(id)) continue;
    group.remove(o);
    o.element.remove();
    labels.delete(id);
  }
  for (const [id, o] of chips) {
    if (seenChips.has(id)) continue;
    group.remove(o);
    o.element.remove();
    chips.delete(id);
  }
}

function unmount() {}

const hitObjects = () => [];

export { hitObjects, mount, sync, unmount };
