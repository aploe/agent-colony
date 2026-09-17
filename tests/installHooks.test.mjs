import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyHooks,
  removeHooks,
  EVENTS,
  worktreeGuard,
  readBaseline,
  checkBaseline,
  checkHookExists,
} from '../scripts/install-hooks.mjs';

const INSTALLER = fileURLToPath(new URL('../scripts/install-hooks.mjs', import.meta.url));
const REAL_HOOK = fileURLToPath(new URL('../hooks/session-status.sh', import.meta.url));

const HOOK = '/repo/hooks/session-status.sh';

const commandsFor = (s, event) =>
  (s.hooks?.[event] ?? []).flatMap((m) => m.hooks.map((h) => h.command));

test('traegt jedes Ereignis genau einmal ein', () => {
  const out = applyHooks({}, HOOK);
  for (const e of EVENTS) {
    const cmds = commandsFor(out, e).filter((c) => c.includes(HOOK));
    assert.equal(cmds.length, 1, `${e} muss genau einen Eintrag haben`);
    assert.ok(cmds[0].endsWith(` ${e}`), `${e} muss als Argument stehen`);
  }
});

test('ist idempotent', () => {
  const once = applyHooks({}, HOOK);
  const twice = applyHooks(structuredClone(once), HOOK);
  assert.deepEqual(twice, once);
});

test('laesst fremde Hooks unangetastet', () => {
  const before = {
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'any-buddy apply --silent' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /h/guard.py' }] }],
    },
  };
  const after = applyHooks(structuredClone(before), HOOK);
  assert.ok(commandsFor(after, 'SessionStart').includes('any-buddy apply --silent'));
  assert.deepEqual(after.hooks.PreToolUse, before.hooks.PreToolUse);
});

test('uninstall entfernt nur die eigenen Eintraege', () => {
  const before = {
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'any-buddy apply --silent' }] }],
    },
  };
  const after = removeHooks(applyHooks(structuredClone(before), HOOK), HOOK);
  assert.ok(commandsFor(after, 'SessionStart').includes('any-buddy apply --silent'));
  for (const e of EVENTS) {
    assert.equal(commandsFor(after, e).filter((c) => c.includes(HOOK)).length, 0);
  }
});

test('uninstall raeumt leer gewordene Ereignisse weg', () => {
  const after = removeHooks(applyHooks({}, HOOK), HOOK);
  assert.deepEqual(after.hooks ?? {}, {});
});

test('andere Settings-Schluessel bleiben erhalten', () => {
  const before = { model: 'opus', permissions: { allow: ['Bash(node:*)'] } };
  const after = applyHooks(structuredClone(before), HOOK);
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, before.permissions);
});

// Fix-Runde 1, Punkt 1: worktreeGuard ist reine Funktion ueber ihre
// Eingaben, kein echter Git-Aufruf im Test.
test('worktreeGuard: Hauptcheckout (gleiche Pfade) blockiert nicht', () => {
  assert.equal(worktreeGuard('/repo/.git', '/repo/.git'), null);
});

test('worktreeGuard: kein Git oder kein Repo blockiert nicht', () => {
  assert.equal(worktreeGuard(null, null), null);
  assert.equal(worktreeGuard('', ''), null);
});

test('worktreeGuard: verlinkter Worktree blockiert und nennt den Hauptcheckout', () => {
  const msg = worktreeGuard('/repo/.git/worktrees/hook-status', '/repo/.git');
  assert.ok(msg, 'muss abbrechen');
  assert.ok(
    msg.includes('/repo'),
    'muss den Hauptcheckout (Elternverzeichnis von --git-common-dir) nennen',
  );
});

// Fix-Runde 1, Punkt 2: Kollisionsschutz fuer beide Baseline-Faelle, ueber
// die echten Dateisystemfunktionen, nicht gemockt.
function freshFile() {
  const dir = mkdtempSync(join(tmpdir(), 'colony-baseline-'));
  return { dir, file: join(dir, 'settings-probe.json') };
}

test('readBaseline: Datei war da -> existed true mit mtime', async () => {
  const { dir, file } = freshFile();
  writeFileSync(file, '{}');
  const baseline = await readBaseline(file);
  assert.equal(baseline.existed, true);
  assert.equal(typeof baseline.mtimeMs, 'number');
  rmSync(dir, { recursive: true, force: true });
});

test('readBaseline: Datei war nicht da (ENOENT) -> existed false', async () => {
  const { dir, file } = freshFile();
  const baseline = await readBaseline(file);
  assert.equal(baseline.existed, false);
  assert.equal(baseline.mtimeMs, null);
  assert.equal(baseline.text, '{}');
  rmSync(dir, { recursive: true, force: true });
});

test('readBaseline: ein Rechtefehler ist kein ENOENT und wirft weiter', async () => {
  const { dir, file } = freshFile();
  writeFileSync(file, '{}');
  chmodSync(file, 0o000);
  await assert.rejects(() => readBaseline(file), /kann nicht gelesen werden/);
  chmodSync(file, 0o600); // sonst kann rmSync die Datei nicht loeschen
  rmSync(dir, { recursive: true, force: true });
});

test('checkBaseline: Datei war da und blieb unveraendert -> kein Fehler', async () => {
  const { dir, file } = freshFile();
  writeFileSync(file, '{}');
  const baseline = await readBaseline(file);
  const problem = await checkBaseline(file, baseline);
  assert.equal(problem, null);
  rmSync(dir, { recursive: true, force: true });
});

test('checkBaseline: Datei war da und aenderte sich waehrenddessen -> Fehler', async () => {
  const { dir, file } = freshFile();
  writeFileSync(file, '{}');
  const baseline = await readBaseline(file);
  await new Promise((r) => setTimeout(r, 5));
  writeFileSync(file, '{"x":1}');
  const problem = await checkBaseline(file, baseline);
  assert.ok(problem && problem.includes(file));
  rmSync(dir, { recursive: true, force: true });
});

test('checkBaseline: Datei war nicht da und ist immer noch nicht da -> kein Fehler', async () => {
  const { dir, file } = freshFile();
  const baseline = await readBaseline(file);
  const problem = await checkBaseline(file, baseline);
  assert.equal(problem, null);
  rmSync(dir, { recursive: true, force: true });
});

// Der eigentliche Fund aus der Review: Datei fehlte beim ersten Zugriff,
// ist aber vor dem Schreiben aufgetaucht (ein anderes Werkzeug hat sie
// angelegt). Vorher gab es fuer diesen Fall ueberhaupt keine Pruefung.
test('checkBaseline: Datei fehlte beim Start, ist aber inzwischen aufgetaucht -> Fehler', async () => {
  const { dir, file } = freshFile();
  const baseline = await readBaseline(file);
  assert.equal(baseline.existed, false);
  writeFileSync(file, '{}'); // "taucht dazwischen auf"
  const problem = await checkBaseline(file, baseline);
  assert.ok(problem && problem.includes(file));
  rmSync(dir, { recursive: true, force: true });
});

// I2: aus dem Hauptcheckout installieren, waehrend `hooks/session-status.sh`
// noch nur im Worktree liegt (vor dem Merge), rief bisher acht Ereignisse auf
// einen fehlenden Pfad ein -- jede Session haette `bash <fehlt>` aufgerufen.
test('checkHookExists: fehlender Pfad ergibt eine Meldung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'colony-hookcheck-'));
  const msg = checkHookExists(join(dir, 'nicht-da.sh'));
  assert.ok(msg && msg.includes('existiert nicht'));
  rmSync(dir, { recursive: true, force: true });
});

test('checkHookExists: der echte Hook im Repo ergibt null', () => {
  assert.equal(checkHookExists(REAL_HOOK), null);
});

// Voller Prozesslauf gegen eine Kopie des Installers ohne Hook-Skript daneben
// (root/hooks/session-status.sh existiert dort bewusst nicht) -- der Fall aus
// I2 end-to-end: Exit ungleich 0, Settings-Datei bleibt byte-identisch.
test('I2: voller Installerlauf ohne Hook-Skript bricht ab, Settings-Datei unveraendert', () => {
  const repo = mkdtempSync(join(tmpdir(), 'colony-fakerepo-'));
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  const installerCopy = join(repo, 'scripts', 'install-hooks.mjs');
  writeFileSync(installerCopy, readFileSync(INSTALLER));
  const settingsFile = join(repo, 'settings.json');
  const before = '{"model":"opus"}';
  writeFileSync(settingsFile, before);

  assert.throws(() => {
    execFileSync('node', [installerCopy, '--settings', settingsFile], { encoding: 'utf8', stdio: 'pipe' });
  }, /Command failed/);

  assert.equal(readFileSync(settingsFile, 'utf8'), before);
  rmSync(repo, { recursive: true, force: true });
});

// M3: eine Settings-Datei mit kaputtem JSON darf den Installer nicht mit
// einem unbehandelten Wurf abstuerzen lassen, sondern eine Meldung wie die
// anderen Fehlerpfade zeigen, und nichts schreiben.
test('M3: kaputtes JSON in der Settings-Datei bricht kontrolliert ab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'colony-badjson-'));
  const settingsFile = join(dir, 'settings.json');
  const before = '{ das ist kein json';
  writeFileSync(settingsFile, before);

  assert.throws(() => {
    execFileSync('node', [INSTALLER, '--settings', settingsFile], { encoding: 'utf8', stdio: 'pipe' });
  }, /Command failed/);

  assert.equal(readFileSync(settingsFile, 'utf8'), before);
  rmSync(dir, { recursive: true, force: true });
});
