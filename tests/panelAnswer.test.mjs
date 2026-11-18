import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choicesComplete, layoutSignature, requestsOf, toggleChoice } from '../public/colony/answer.mjs';

// Made-up questions.
const single = { question: 'Colour?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] };
const multi = { question: 'Sides?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] };

test('a single choice takes the clicked option', () => {
  let c = toggleChoice([single], undefined, 0, 1);
  assert.deepEqual(c, [[1]]);
  c = toggleChoice([single], c, 0, 0);
  assert.deepEqual(c, [[0]]);
});

test('a multiple choice adds and removes, sorted', () => {
  let c = toggleChoice([single, multi], undefined, 1, 2);
  c = toggleChoice([single, multi], c, 1, 0);
  assert.deepEqual(c, [[], [0, 2]]);
  c = toggleChoice([single, multi], c, 1, 2);
  assert.deepEqual(c, [[], [0]]);
});

test('complete only when every question has what it needs', () => {
  assert.equal(choicesComplete([single, multi], undefined), false);
  assert.equal(choicesComplete([single, multi], [[1], []]), false);
  assert.equal(choicesComplete([single, multi], [[1], [0, 1]]), true);
});

test('requestsOf copes with agents without requests', () => {
  assert.deepEqual(requestsOf({}), []);
  assert.deepEqual(requestsOf(null), []);
  assert.deepEqual(requestsOf({ requests: [{ id: 'r' }] }), [{ id: 'r' }]);
});

test('the layout signature changes when a block moves', () => {
  const a = layoutSignature({ hexId: 'h', height: 400, blocks: [{ id: 'r', top: 100 }] });
  const b = layoutSignature({ hexId: 'h', height: 400, blocks: [{ id: 'r', top: 120 }] });
  assert.notEqual(a, b);
  assert.equal(a, layoutSignature({ hexId: 'h', height: 400, blocks: [{ id: 'r', top: 100 }] }));
});
