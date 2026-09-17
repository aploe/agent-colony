import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHookStatus } from '../src/sources/hookStatus.mjs';

function dirWith(files, subdirs = {}) {
  const base = mkdtempSync(join(tmpdir(), 'colony-read-'));
  const dir = join(base, 'agent-colony');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  for (const [name, markers] of Object.entries(subdirs)) {
    const sub = join(dir, name);
    mkdirSync(sub);
    for (const marker of markers) writeFileSync(join(sub, marker), '');
  }
  return { base, dir };
}

// R16: `subagents` ist kein Feld der Statusdatei mehr -- der Hook legt pro
// laufendem Subagenten eine leere Markerdatei unter `<sessionId>.subagents/`
// an. Der Leser zaehlt die Eintraege selbst, statt ein Zahlenfeld zu lesen.
test('liest Eintraege als Map, zaehlt Subagenten aus dem Marker-Verzeichnis', async () => {
  const { base, dir } = dirWith(
    {
      'aaa.json': '{"sessionId":"aaa","status":"waiting","since":"2026-09-11T00:00:00Z"}',
      'bbb.json': '{"sessionId":"bbb","status":"working","since":"2026-09-11T00:05:00Z"}',
    },
    {
      'aaa.subagents': ['agent-1', 'agent-2'],
    },
  );
  const map = await loadHookStatus({ hookStatusDir: dir });
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('aaa'), { status: 'waiting', since: '2026-09-11T00:00:00Z', subagents: 2 });
  assert.equal(map.get('bbb').status, 'working');
  assert.equal(map.get('bbb').subagents, 0, 'kein Marker-Verzeichnis heisst null laufende Subagenten');
  rmSync(base, { recursive: true, force: true });
});

test('haelt halb geschriebene Dateien aus', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"idle","since":"2026-09-11T00:00:00Z"}',
    'bbb.json': '{"sessionId":"bbb","stat',
  });
  const map = await loadHookStatus({ hookStatusDir: dir });
  assert.equal(map.size, 1, 'die kaputte Datei faellt still raus');
  rmSync(base, { recursive: true, force: true });
});

// R24: der Hook meldet eine Permission-Abfrage jetzt eindeutig als `prompt`,
// nicht mehr vermischt mit `waiting`. Vier Woerter, exakt die der Karte.
test('akzeptiert den vierten Zustand prompt', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"prompt","since":"2026-09-12T00:00:00Z"}',
  });
  const map = await loadHookStatus({ hookStatusDir: dir });
  assert.equal(map.get('aaa').status, 'prompt');
  rmSync(base, { recursive: true, force: true });
});

test('verwirft Eintraege mit unbekanntem Status', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"tanzt","since":"2026-09-11T00:00:00Z"}',
  });
  const map = await loadHookStatus({ hookStatusDir: dir });
  assert.equal(map.size, 0);
  rmSync(base, { recursive: true, force: true });
});

test('fehlendes Verzeichnis ergibt null, nicht eine leere Map', async () => {
  const map = await loadHookStatus({ hookStatusDir: join(tmpdir(), 'gibt-es-nicht-4711') });
  assert.equal(map, null, 'null heisst unbekannt, leere Map hiesse niemand arbeitet');
});

// Ein Marker-Verzeichnis ohne zugehoerige Statusdatei kann real vorkommen:
// SessionEnd raeumt Datei und Verzeichnis zusammen weg, aber dazwischen kann
// ein Poll liegen, der nur eines von beiden schon geloescht sieht -- oder,
// symmetrisch, die Statusdatei existiert (noch) laenger als das gerade erst
// angelegte Marker-Verzeichnis eines frisch gestarteten Subagenten. Ohne
// Statusdatei gibt es keine sessionId-Zuordnung fuer den Leser -- er kennt
// nur, was in den .json-Dateien steht. Ein verwaistes Marker-Verzeichnis
// bleibt darum unsichtbar, es erzeugt keinen Map-Eintrag aus dem Nichts.
test('Marker-Verzeichnis ohne Statusdatei erzeugt keinen Eintrag', async () => {
  const { base, dir } = dirWith({}, { 'ccc.subagents': ['agent-1'] });
  const map = await loadHookStatus({ hookStatusDir: dir });
  assert.equal(map.size, 0);
  rmSync(base, { recursive: true, force: true });
});
