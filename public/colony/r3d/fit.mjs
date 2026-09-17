/* Normierung eines Modells auf die Zielgroesse seiner Rolle — reine Rechnung
 * auf einer Bounding-Box, ohne three, damit sie unter node --test laeuft.
 *
 * box = { min: [x,y,z], max: [x,y,z] }. Genau ein Ziel:
 *   height    -> Hoehe (y) wird target.height
 *   footprint -> die groessere Grundflaechen-Kante (x oder z) wird target.footprint
 *   across    -> die kleinere Grundflaechen-Kante wird target.across (Stege:
 *                die lange Achse ist die Laenge, die kurze die Breite)
 * Ergebnis: { scale, offset, size }. Nach scale und offset steht der Fuss
 * auf y=0 und die Mitte der Grundflaeche auf x=z=0 — so wie die heutigen
 * Primitive (translate(0, h/2, 0)) gebaut sind. */
export function fitSpec(box, target) {
  const size = [0, 1, 2].map((i) => box.max[i] - box.min[i]);
  let scale;
  if (target.height != null) scale = target.height / size[1];
  else if (target.footprint != null) scale = target.footprint / Math.max(size[0], size[2]);
  else if (target.across != null) scale = target.across / Math.min(size[0], size[2]);
  else throw new Error('fitSpec: Ziel fehlt (height, footprint oder across)');
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('fitSpec: entartete Box ' + JSON.stringify(size));
  const cx = (box.min[0] + box.max[0]) / 2;
  const cz = (box.min[2] + box.max[2]) / 2;
  return {
    scale,
    offset: [-cx * scale + 0, -box.min[1] * scale + 0, -cz * scale + 0],
    size: size.map((v) => v * scale),
  };
}
