/* U-Buchten in einer Parent-Plattform, dort wo ein Steg ansetzt (Kit-Skin,
 * seit 2026-09-14, Andrés Wunsch: der Steg soll nicht in die Plattform
 * "einschneiden"). Reine Geometrie, plattform-lokal in Welt-xz:
 *
 * - Die Plattform bekommt eine Deckplatte (NOTCH_FLOOR dick) mit
 *   ausgeschnittenen U-Buchten; der Block darunter bleibt die Instanz aus
 *   tiles.mjs, um NOTCH_FLOOR abgesenkt. Der Steg liegt in der Bucht, sein
 *   Boden auf ihrem Boden.
 * - Die Leuchtkante folgt der Kontur und zieht das U mit (durchgezogen oder
 *   gestrichelt wie in tiles.mjs); Hover- und Auswahlring lassen an der
 *   Bucht eine Luecke.
 *
 * Aufbau der Kontur: die Sechseck-Kante wird als Weg mit Parameter p in
 * [0, 6) gelaufen (Kante floor(p), Anteil p - floor(p)); je Bucht schneiden
 * die beiden Seitenlinien des U die Kante an zwei Parametern, dazwischen
 * wird der Umweg nach innen (Seite, Halbkreis, Seite) eingesetzt. Start ist
 * eine Ecke, die in keiner Bucht liegt. */

import * as THREE from 'three';
import { BRIDGE_W, TILE_R, rimDist } from './world.mjs';

const NOTCH_W = BRIDGE_W + 4;  // Breite der Bucht: Steg plus 2 Luft je Seite
const NOTCH_DEPTH = 16;        // von der Kante bis zum innersten Punkt des U
const NOTCH_FLOOR = 3;         // so tief unter der Oberkante liegt der Boden der Bucht
const HW = NOTCH_W / 2;
const ARC_N = 8;               // Segmente des Halbkreises
const RING_SUB = 24;           // Unterteilung je Sechseck-Kante fuer den Ring mit Luecken
const S3 = Math.sqrt(3) / 2;   // Umkreisradius -> Apothem

/* Bucht aus einer Stegrichtung (Einheitsvektor von der Plattformmitte). */
function notchOf(ux, uz) {
  return { ux, uz, nx: -uz, nz: ux, rIn: rimDist(Math.atan2(uz, ux)) - NOTCH_DEPTH, hw: HW };
}

/* Liegt der lokale Punkt (x, z) in der Bucht, mit `pad` Rand? */
function inNotch(n, x, z, pad = 0) {
  return x * n.ux + z * n.uz > n.rIn - pad && Math.abs(x * n.nx + z * n.nz) < n.hw + pad;
}

/* Ecken auf 0, 60, 120 Grad (flat-top wie hexPath in 2D und die Prismen in tiles.mjs). */
function hexVerts(r = TILE_R) {
  const V = [];
  for (let k = 0; k < 6; k++) V.push([Math.cos((Math.PI / 3) * k) * r, Math.sin((Math.PI / 3) * k) * r]);
  return V;
}

/* Strahl a + t*ad gegen Strecke b + s*bd: { t, s } oder null bei parallel. */
function rayVsSegment(ax, az, adx, adz, bx, bz, bdx, bdz) {
  const cross = adx * bdz - adz * bdx;
  if (Math.abs(cross) < 1e-9) return null;
  const ex = bx - ax;
  const ez = bz - az;
  return { t: (ex * bdz - ez * bdx) / cross, s: (ex * adz - ez * adx) / cross };
}

function lineIntersect(l1, l2) {
  const r = rayVsSegment(l1.x, l1.z, l1.dx, l1.dz, l2.x, l2.z, l2.dx, l2.dz);
  return r ? [l1.x + r.t * l1.dx, l1.z + r.t * l1.dz] : null;
}

/* Kontur der Plattform mit Buchten, als Punktliste [x, z], geschlossen gedacht. */
function outline(notches) {
  const V = hexVerts();
  const at = (p) => {
    const i = ((Math.floor(p) % 6) + 6) % 6;
    const f = p - Math.floor(p);
    const a = V[i];
    const b = V[(i + 1) % 6];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  // Parameter, an dem ein Strahl aus dem Inneren die Kante verlaesst
  const exitParam = (ox, oz, dx, dz) => {
    for (let i = 0; i < 6; i++) {
      const a = V[i];
      const b = V[(i + 1) % 6];
      const r = rayVsSegment(ox, oz, dx, dz, a[0], a[1], b[0] - a[0], b[1] - a[1]);
      if (r && r.t > 0 && r.s >= 0 && r.s <= 1) return i + r.s;
    }
    return null;
  };
  const cuts = [];
  for (const n of notches) {
    const pA = exitParam(n.nx * n.hw, n.nz * n.hw, n.ux, n.uz);
    const pB = exitParam(-n.nx * n.hw, -n.nz * n.hw, n.ux, n.uz);
    if (pA === null || pB === null) continue;
    const aFirst = ((pB - pA + 6) % 6) < 3; // die Bucht ist der kurze Weg zwischen beiden Schnitten
    const pIn = aFirst ? pA : pB;
    const len = ((aFirst ? pB : pA) - pIn + 6) % 6;
    // Umweg: Seite des Eintritts nach innen, Halbkreis um den Bogenmittelpunkt
    // (rIn + hw auf der Stegachse), Seite des Austritts wieder hinaus.
    const cx = n.ux * (n.rIn + n.hw);
    const cz = n.uz * (n.rIn + n.hw);
    const sign = aFirst ? 1 : -1;
    const detour = [];
    for (let k = 0; k <= ARC_N; k++) {
      const phi = (k / ARC_N) * Math.PI;
      const c = Math.cos(phi) * sign;
      const s = Math.sin(phi);
      detour.push([cx + n.hw * (n.nx * c - n.ux * s), cz + n.hw * (n.nz * c - n.uz * s)]);
    }
    cuts.push({ pIn, len, detour });
  }
  const inside = (p, c) => (((p - c.pIn) % 6) + 6) % 6 < c.len;
  let s0 = [0, 1, 2, 3, 4, 5].find((k) => !cuts.some((c) => inside(k, c)));
  if (s0 === undefined) s0 = cuts.length ? (cuts[0].pIn + cuts[0].len) % 6 : 0;
  const rel = (p) => (((p - s0) % 6) + 6) % 6;
  cuts.sort((a, b) => rel(a.pIn) - rel(b.pIn));
  const order = [0, 1, 2, 3, 4, 5].sort((a, b) => rel(a) - rel(b));
  const pts = [at(s0)];
  const vertsBetween = (from, to) => {
    for (const k of order) {
      const r = rel(k);
      if (r > from && r < to) pts.push(V[k]);
    }
  };
  let cur = 0;
  for (const c of cuts) {
    const r = rel(c.pIn);
    vertsBetween(cur, r);
    pts.push(at(c.pIn), ...c.detour, at(c.pIn + c.len));
    cur = r + c.len;
  }
  vertsBetween(cur, 6);
  // doppelte Nachbarn raus (Schnitt genau auf einer Ecke)
  const out = [];
  for (const q of pts) {
    const last = out[out.length - 1] ?? out[0];
    if (last && Math.hypot(last[0] - q[0], last[1] - q[1]) < 1e-6) continue;
    out.push(q);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

/* Kontur um d nach innen versetzt (Gehrung an jeder Ecke). Innen ist die
 * Seite, auf der das Polygon liegt -- Vorzeichen der Flaeche entscheidet. */
function offsetPoly(P, d) {
  const n = P.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sg = area > 0 ? 1 : -1;
  const lines = P.map((a, i) => {
    const b = P[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    return { x: a[0] + (-dz / L) * sg * d, z: a[1] + (dx / L) * sg * d, dx, dz };
  });
  return P.map((_, i) => {
    const l1 = lines[(i - 1 + n) % n];
    const l2 = lines[i];
    return lineIntersect(l1, l2) ?? [l2.x, l2.z];
  });
}

/* Flaches Band zwischen zwei Innenversaetzen d0 < d1 der Kontur P, in XZ
 * mit Normale +y (DoubleSide-Material, Wicklung egal). Gestrichelt wie
 * dashedRimGeometry in tiles.mjs: das Muster faengt auf jedem Kontursegment
 * neu an, Zyklen auf die Segmentlaenge gerundet. `skip(mx, mz)` laesst ein
 * Teilstueck aus, dessen Mitte es bejaht (Ring mit Luecken). */
function band(P, d0, d1, { dashed = false, dash = 6, gap = 5, sub = 1, skip = null } = {}) {
  const O = d0 ? offsetPoly(P, d0) : P;
  const I = offsetPoly(P, d1);
  const pos = [];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const quad = (o0, o1, i0, i1) => {
    pos.push(o0[0], 0, o0[1], i1[0], 0, i1[1], o1[0], 0, o1[1]);
    pos.push(o0[0], 0, o0[1], i0[0], 0, i0[1], i1[0], 0, i1[1]);
  };
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let pieces;
    if (dashed) {
      const L = Math.hypot(O[j][0] - O[i][0], O[j][1] - O[i][1]);
      const cycles = Math.max(1, Math.round(L / (dash + gap)));
      const step = 1 / cycles;
      const on = step * (dash / (dash + gap));
      pieces = [];
      for (let c = 0; c < cycles; c++) pieces.push([c * step, c * step + on]);
    } else {
      pieces = [];
      for (let c = 0; c < sub; c++) pieces.push([c / sub, (c + 1) / sub]);
    }
    for (const [t0, t1] of pieces) {
      const o0 = lerp(O[i], O[j], t0);
      const o1 = lerp(O[i], O[j], t1);
      if (skip) {
        const m = lerp(o0, o1, 0.5);
        if (skip(m[0], m[1])) continue;
      }
      quad(o0, o1, lerp(I[i], I[j], t0), lerp(I[i], I[j], t1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/* Deckplatte mit Buchten: das Prisma der Kontur, NOTCH_FLOOR dick, Oberkante
 * bei y=0 (ExtrudeGeometry hat flache Normalen, wie die Instanz in tiles.mjs
 * seit toNonIndexed). Shape-y ist -Welt-z, damit rotateX(-pi/2) die Kontur
 * unverdreht in XZ legt. */
function topGeometry(notches) {
  const P = outline(notches);
  const shape = new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: NOTCH_FLOOR, bevelEnabled: false, steps: 1 })
    .rotateX(-Math.PI / 2)
    .translate(0, -NOTCH_FLOOR, 0);
  g.computeBoundingSphere();
  return g;
}

/* Leuchtkante entlang der Kontur, so breit wie rimGeo in tiles.mjs
 * (RIM_W = 5 im Umkreisradius = 5 * sqrt(3)/2 senkrecht zur Kante). */
function rimGeometry(notches, dashed, rimW = 5) {
  return band(outline(notches), 0, rimW * S3, { dashed });
}

/* Hover-/Auswahlring wie hiGeo in tiles.mjs (Umkreisradien TILE_R-12 bis
 * TILE_R-5.5), auf dem glatten Sechseck, mit Luecke an jeder Bucht. */
function ringGeometry(notches) {
  const skip = (x, z) => notches.some((n) => inNotch(n, x, z, 2));
  return band(hexVerts(), 5.5 * S3, 12 * S3, { sub: RING_SUB, skip });
}

export { NOTCH_DEPTH, NOTCH_FLOOR, NOTCH_W, inNotch, notchOf, outline, rimGeometry, ringGeometry, topGeometry };
