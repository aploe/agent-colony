/* Haltung und Gang der Kit-Hauptfigur, prozedural auf den Knochen des
 * Klons. Kein Clip aus der Datei: der Little Astronaut bringt nur einen
 * 10-Sekunden-Sammelclip mit (mehrere Posen, die Wurzel wandert), keinen
 * sauberen Geh-Zyklus. Ein Gang aus Sinus auf vier Gelenken haengt dafuer
 * direkt am zurueckgelegten Weg (motion.mjs fuehrt die Phase) -- Arme und
 * Beine schwingen genau so schnell, wie die Figur ueber die Welt kommt.
 *
 * Achsen, am Bild kalibriert (2026-09-14): der GLTFLoader nimmt die Punkte
 * aus den Knochennamen (UpperArm.r_07 -> UpperArmr_07); lokal +y liegt
 * entlang jedes Knochens, Z senkt einen Arm aus der T-Pose der Datei an
 * den Koerper, X schwingt Arm und Bein vor und zurueck. Die Arme haengen
 * seither auch im Stand, statt in der T-Pose der Datei.
 *
 * Fremdes Modell im Manifest ohne diese Knochen: attach() liefert null,
 * die Figur laeuft dann ohne Gliederschwung -- kein Fehler, kein Rueckfall. */

import * as THREE from 'three';

const NAMES = {
  armR: 'UpperArmr_07', armL: 'UpperArml_015',
  foreR: 'LowerArmr_08', foreL: 'LowerArml_016',
  legR: 'upperLegr_022', legL: 'upperLegl_025',
  shinR: 'lowerlegr_023', shinL: 'lowerlegl_00',
  spine: 'Spine1_02',
};
const ARM_DOWN = 1.25;   // T-Pose -> Arme haengen
const ARM_SWING = 0.55;
const ELBOW = 0.35;      // leichte Beuge, auch im Stand
const LEG_SWING = 0.55;
const KNEE = 0.8;        // Beuge des Schwungbeins
const LEAN = 0.1;        // Oberkoerper leicht nach vorn beim Gehen
const BOB = 0.4;         // Auf und Ab des Koerpers je Schritt
// Sitzen (idle): auf dem Boden, Beine gestreckt und gespreizt nach vorn,
// Haende auf den Oberschenkeln. Ein Stuhl (Kenney, 2026-09-14) ist wieder
// raus: mit dem Rucksack sah die Figur darauf nicht gut aus (André). Die
// Chibi-Beine sind kurz (Oberschenkel 1, Unterschenkel 1,3); gestreckt und
// gespreizt bleiben Knie und Fuesse vor dem Bauch sichtbar. figures.mjs
// senkt die sitzende Figur um SIT_DROP, bis das Becken auf der Plattform
// liegt (am Modell gemessen).
const SIT_HIP = 1.5;
const SIT_KNEE = 0.15;
const SIT_SPREAD = 0.3;   // Beine um die Laengsachse nach aussen: ein flaches V vor dem Bauch
const SIT_ARM = 0.6;
const SIT_ELBOW = 0.7;
const SIT_LEAN = 0.12;

const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();

function attach(model) {
  const r = {};
  for (const [k, name] of Object.entries(NAMES)) {
    const bone = model.getObjectByName(name);
    if (!bone) return null;
    r[k] = { bone, rest: bone.quaternion.clone() };
  }
  return r;
}

function set(b, rots) {
  b.bone.quaternion.copy(b.rest);
  for (const [axis, ang] of rots) if (ang) b.bone.quaternion.multiply(_q.setFromAxisAngle(axis, ang));
}

/* phase: Gangphase in rad (ein Zyklus = beide Schritte), k: Gehanteil 0..1
 * (0 = Stand mit haengenden Armen, 1 = voller Schwung), sit: Sitzanteil
 * 0..1 (blendet Gang aus und Sitzhaltung ein). Rechtes Bein und linker Arm
 * schwingen gemeinsam nach vorn; das Knie beugt sich, waehrend das Bein von
 * hinten nach vorn schwingt. +X ist an Armen wie Beinen "nach vorn". */
function pose(r, phase, k, sit = 0) {
  const s = Math.sin(phase) * k * (1 - sit);
  const c = Math.cos(phase) * k * (1 - sit);
  set(r.armR, [[Z, ARM_DOWN], [X, -ARM_SWING * s + SIT_ARM * sit]]);
  set(r.armL, [[Z, -ARM_DOWN], [X, ARM_SWING * s + SIT_ARM * sit]]);
  set(r.foreR, [[X, ELBOW + (SIT_ELBOW - ELBOW) * sit]]);
  set(r.foreL, [[X, ELBOW + (SIT_ELBOW - ELBOW) * sit]]);
  set(r.legR, [[Z, SIT_SPREAD * sit], [X, LEG_SWING * s + SIT_HIP * sit]]);
  set(r.legL, [[Z, -SIT_SPREAD * sit], [X, -LEG_SWING * s + SIT_HIP * sit]]);
  set(r.shinR, [[X, KNEE * Math.max(0, c) + SIT_KNEE * sit]]);
  set(r.shinL, [[X, KNEE * Math.max(0, -c) + SIT_KNEE * sit]]);
  set(r.spine, [[X, LEAN * k * (1 - sit) + SIT_LEAN * sit]]);
}

const bob = (phase, k) => BOB * Math.abs(Math.sin(phase)) * k;

export { attach, bob, pose };
