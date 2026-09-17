/* Rueckweg Bildschirm -> Welt per Raycasting (ersetzt hexAt/dayAt aus 2D,
 * der handgeschriebene Rueckweg toWorld() traegt in 3D nicht) und Hinweg
 * Welt -> Bildschirm (anchorScreen, fuer sl-popup mit virtuellem Anker).
 *
 * Getroffen wird, was gerade gezeichnet ist: die Instanzmatrizen kommen
 * aus worldOf(h, idx, now), waehrend einer Umordnungsfahrt also die
 * interpolierte Position — ein Klick mitten in der Fahrt trifft die Wabe,
 * wo sie gerade steht, nicht wo sie hinfaehrt. */

import * as THREE from 'three';
import * as bend from './bend.mjs';
import * as builds from './builds.mjs';
import * as figures from './figures.mjs';
import { camera } from './camera.mjs';
import * as tiles from './tiles.mjs';

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const v = new THREE.Vector3();

/* Die Meshes liegen flach vor, gezeichnet werden sie gesenkt (bend.mjs).
 * Der Strahl wird darum um die Senkung am Treffer angehoben und neu
 * geworfen, bis der Treffer stillsteht -- zwei, drei Runden, die Senkung
 * aendert sich glatt. Ein Strahl, der flach nichts trifft, trifft auch
 * gebogen nichts: die Welt sinkt nur. */
function cast(sx, sy, objects) {
  if (!objects.length) return null;
  ndc.set((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const y0 = ray.ray.origin.y;
  const first = () => {
    const hits = ray.intersectObjects(objects, false);
    return hits.length ? hits[0] : null;
  };
  let hit = first();
  let lifted = 0;
  for (let i = 0; hit && i < 4; i++) {
    const d = bend.drop(hit.point.x, hit.point.z);
    if (Math.abs(d - lifted) < 0.5) break;
    lifted = d;
    ray.ray.origin.y = y0 + d;
    hit = first();
  }
  return hit;
}

/* Welt -> Bildschirm, die Umkehrung von toWorld() in 2D; die flache
 * Weltposition wird vorher gesenkt wie im Shader. */
function anchorScreen(pos) {
  v.set(pos.x, pos.y - bend.drop(pos.x, pos.z), pos.z).project(camera);
  return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
}

function pickHex(sx, sy) {
  const hit = cast(sx, sy, tiles.hitObjects());
  if (!hit) return null;
  if (hit.instanceId === undefined) return hit.object.userData.hex ?? null; // Einzelmesh: Plattform mit Buchten (Kit)
  return hit.object.userData.hexes[hit.instanceId] ?? null; // Hangar ist null, wie hexAt()
}

/* Die Figur unter dem Zeiger: { key, hexId } oder null. Das Gegenstueck zu
 * agentAt() in 2D — dort gemerkte Zeichenpositionen, hier ein Strahl gegen
 * die Trefferkaesten aus figures.mjs. */
function pickAgent(sx, sy) {
  const hit = cast(sx, sy, figures.hitObjects());
  const data = hit?.object.userData;
  return data?.key && data.hexId ? { key: data.key, hexId: data.hexId } : null;
}

/* Bildschirmrechteck eines Tagesbaus fuer die Hover-Card: von der Oberkante
 * bis zum Fuss, drei Pixel Luft seitlich. */
function rectOf(slot) {
  const t = anchorScreen(slot.top);
  const b = anchorScreen(slot.base);
  return {
    x: Math.min(t.x, b.x) - 3,
    y: Math.min(t.y, b.y),
    w: Math.abs(t.x - b.x) + 6,
    h: Math.max(4, Math.abs(b.y - t.y)),
  };
}

/* Tagesbau unter dem Cursor. Trefferzone ist der Kasten selbst — enger als
 * das ganze Band in 2D (Plan, Abweichung 7). */
function pickDay(sx, sy) {
  const hit = cast(sx, sy, builds.hitObjects());
  if (!hit || hit.instanceId === undefined) return null;
  const slot = hit.object.userData.slots[hit.instanceId];
  if (!slot) return null;
  return { hex: slot.hex, day: slot.day, rect: rectOf(slot) };
}

export { anchorScreen, pickAgent, pickDay, pickHex, rectOf };
