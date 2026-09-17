import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitSpec } from '../public/colony/r3d/fit.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ': ' + a + ' vs ' + b);

test('height: Wuerfel 2 hoch auf 12 -> Skalierung 6, Fuss bleibt auf 0', () => {
  const s = fitSpec({ min: [-1, 0, -1], max: [1, 2, 1] }, { height: 12 });
  near(s.scale, 6, 'scale');
  assert.deepEqual(s.offset, [-0, -0, -0].map((v) => v + 0));
  assert.deepEqual(s.size, [12, 12, 12]);
});

test('footprint: die groessere Grundflaechen-Kante wird zur Zielgroesse', () => {
  const s = fitSpec({ min: [0, 0, 0], max: [2, 1, 4] }, { footprint: 8 });
  near(s.scale, 2, 'scale');
  assert.deepEqual(s.offset, [-2, -0 + 0, -4]);
  assert.deepEqual(s.size, [4, 2, 8]);
});

test('across: die kleinere Grundflaechen-Kante wird zur Zielgroesse', () => {
  const s = fitSpec({ min: [0, 0, 0], max: [2, 1, 4] }, { across: 9 });
  near(s.scale, 4.5, 'scale');
  assert.deepEqual(s.size, [9, 4.5, 18]);
});

test('Fuss ueber Null wandert auf Null', () => {
  const s = fitSpec({ min: [-1, 3, -1], max: [1, 5, 1] }, { height: 1 });
  near(s.offset[1], -1.5, 'offset.y');
});

test('ohne Ziel oder mit entarteter Box wirft fitSpec', () => {
  assert.throws(() => fitSpec({ min: [0, 0, 0], max: [1, 1, 1] }, {}), /Ziel/);
  assert.throws(() => fitSpec({ min: [0, 0, 0], max: [1, 0, 1] }, { height: 5 }), /entartet/);
});
