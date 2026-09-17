import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layout } from '../public/colony/hexmap.mjs';

/* Reine Funktion ihrer Eingabe: layout() setzt q/r/hidden auf die Felder.
 * Hier nur, was 2026-09-14 schiefging: versteckte Kinder ohne Zelle. */

const hex = (id, parentId = null) => ({ id, parentId, agents: [], sessions: { total: 0, fresh: 0 }, gitState: 'clean' });
const family = () => [hex('root'), hex('a', 'root'), hex('b', 'root'), hex('c', 'b'), hex('other')];

test('zugeklappte Kinder sind versteckt, haben aber eine Zelle', () => {
  const shut = layout(family(), new Set(['root']));
  assert.deepEqual(shut.filter((h) => h.hidden).map((h) => h.id), ['a', 'b', 'c']);
  for (const h of shut) {
    assert.ok(Number.isFinite(h.q) && Number.isFinite(h.r), h.id + ' hat eine Zelle: ' + h.q + ',' + h.r);
  }
});

test('zugeklappte Kinder sitzen auf der Zelle ihres Containers', () => {
  const shut = layout(family(), new Set(['root']));
  const root = shut.find((h) => h.id === 'root');
  for (const id of ['a', 'b', 'c']) {
    const h = shut.find((x) => x.id === id);
    assert.deepEqual([h.q, h.r], [root.q, root.r], id + ' sitzt auf dem Container');
  }
});

/* Der Punkt des Zuklappens: die Familie gibt ihre Flaeche frei. Vorher hielten
 * die versteckten Kinder ihre Zellen besetzt, die Karte zerfiel in Inseln und
 * "ordnen" konnte daran nichts aendern (2026-09-15). */
test('eine zugeklappte Familie gibt ihre Zellen frei', () => {
  const belegt = (hs) => new Set(hs.filter((h) => !h.hidden).map((h) => h.q + ',' + h.r));
  assert.equal(belegt(layout(family())).size, 5, 'aufgeklappt fuenf Zellen');
  assert.equal(belegt(layout(family(), new Set(['root']))).size, 2, 'zugeklappt nur noch zwei');
});

test('sichtbare Felder teilen sich keine Zelle, Ring 0 bleibt frei', () => {
  const shut = layout(family(), new Set(['root'])).filter((h) => !h.hidden);
  const cells = new Set(shut.map((h) => h.q + ',' + h.r));
  assert.equal(cells.size, shut.length, 'keine zwei sichtbaren Felder auf einer Zelle');
  assert.ok(!cells.has('0,0'), 'Ring 0 gehoert dem Hangar');
});
