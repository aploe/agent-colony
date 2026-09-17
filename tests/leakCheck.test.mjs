import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPath, parsePatterns, scanDiff, scanRaw, scanText } from '../scripts/leak-check.mjs';

const patterns = parsePatterns('# comment\n\nsecretproject\n/home/someone\\b\n');

test('parsePatterns: comments and blank lines are skipped, matching ignores case', () => {
  assert.equal(patterns.length, 2);
  assert.ok(patterns[0].test('SecretProject'));
});

test('parsePatterns: a broken expression names its line', () => {
  assert.throws(() => parsePatterns('ok\n(unclosed\n'), /line 2/);
});

test('checkPath: workshop, its links and local config are forbidden, product paths are not', () => {
  for (const p of ['workshop', 'workshop/CLAUDE.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/skills/x/SKILL.md',
    '.handoffs', '.handoffs/a.md', 'config/colony.local.json', 'fundus/x.png', 'scratchpad/a.json']) {
    assert.ok(checkPath(p), p);
  }
  for (const p of ['src/server.mjs', 'docs/STATE.md', 'config/colony.config.json', 'scripts/workshop.sh', 'public/CLAUDE.md']) {
    assert.equal(checkPath(p), null, p);
  }
});

test('scanDiff: added lines with file and new line number, removed and header lines ignored', () => {
  const diff = [
    'diff --git a/src/a.mjs b/src/a.mjs',
    'index 111..222 100644',
    '--- a/src/a.mjs',
    '+++ b/src/a.mjs',
    '@@ -10,2 +10,3 @@ function x() {',
    ' context',
    '-// removed secretproject',
    '+// added for secretproject',
    '+const home = "/home/someone/x";',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-secretproject',
  ].join('\n');
  const f = scanDiff(diff, patterns);
  assert.deepEqual(f.map((x) => x.where), ['src/a.mjs:11', 'src/a.mjs:12']);
});

test('scanDiff: an added line that itself starts with "++ " is content, not a header', () => {
  const diff = ['diff --git a/n.md b/n.md', '--- a/n.md', '+++ b/n.md', '@@ -0,0 +1 @@', '+++ secretproject'].join('\n');
  assert.deepEqual(scanDiff(diff, patterns).map((x) => x.where), ['n.md:1']);
});

test('scanRaw: forbidden paths and gitlinks, deletions and renames away are fine', () => {
  const raw = [
    ':000000 100644 0000 aaaa A', 'workshop/CLAUDE.md',
    ':000000 160000 0000 bbbb A', 'vendorrepo',
    ':100644 000000 cccc 0000 D', 'CLAUDE.md',
    ':100644 100644 dddd dddd R100', '.handoffs/a.md', 'notes/a.md',
    ':100644 100644 eeee ffff M', 'src/server.mjs',
    '',
  ].join('\0');
  const f = scanRaw(raw);
  assert.deepEqual(f.map((x) => `${x.where} ${x.reason.split(' ')[0]}`), ['workshop/CLAUDE.md path', 'vendorrepo gitlink']);
});

test('scanText: labels hits with line numbers', () => {
  const f = scanText('commit message', 'fix: thing\n\nmeasured on secretproject', patterns);
  assert.deepEqual(f.map((x) => x.where), ['commit message:3']);
});
