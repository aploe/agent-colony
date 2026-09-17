import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../hooks/session-status.sh', import.meta.url).pathname;
const SID = '11111111-2222-3333-4444-555555555555';

function fire(dir, event, extra = {}) {
  const payload = JSON.stringify({ session_id: SID, cwd: '/home/user/x', ...extra });
  execFileSync('bash', [HOOK, event], {
    input: payload,
    env: { ...process.env, XDG_RUNTIME_DIR: dir },
  });
}

// Asynchrone Variante fuer den Nebenlaeufigkeitstest -- execFileSync kann
// keine zwei Hook-Aufrufe wirklich gleichzeitig laufen lassen.
function fireAsync(dir, event, extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ session_id: SID, cwd: '/home/user/x', ...extra });
    const child = spawn('bash', [HOOK, event], {
      env: { ...process.env, XDG_RUNTIME_DIR: dir },
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.stdin.end(payload);
  });
}

const read = (dir) => JSON.parse(readFileSync(join(dir, 'agent-colony', `${SID}.json`), 'utf8'));

const markerDir = (dir) => join(dir, 'agent-colony', `${SID}.subagents`);
const markers = (dir) => (existsSync(markerDir(dir)) ? readdirSync(markerDir(dir)) : []);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'colony-hook-'));
  return dir;
}

test('SessionStart legt die Datei mit idle an', () => {
  const dir = fresh();
  fire(dir, 'SessionStart');
  const rec = read(dir);
  assert.equal(rec.sessionId, SID);
  assert.equal(rec.status, 'idle');
  assert.equal(rec.subagents, undefined, 'subagents ist kein Feld der Statusdatei mehr (R16)');
  // M2: cwd und event haben keinen Konsumenten und stehen nicht mehr in der
  // Statusdatei -- cwd stand zudem unescaped im JSON (Risiko bei einem
  // Anfuehrungszeichen im Pfad).
  assert.equal(rec.cwd, undefined, 'cwd ist kein Feld der Statusdatei mehr (M2)');
  assert.equal(rec.event, undefined, 'event ist kein Feld der Statusdatei mehr (M2)');
  rmSync(dir, { recursive: true, force: true });
});

// M2: ein Anfuehrungszeichen im Pfad durfte die Statusdatei frueher kaputt
// machen (cwd stand unescaped im JSON) -- ohne cwd im Datensatz kann das
// nicht mehr passieren.
test('ein Anfuehrungszeichen in cwd macht die Statusdatei nicht mehr kaputt (M2)', () => {
  const dir = fresh();
  fire(dir, 'SessionStart', { cwd: '/home/user/x"y' });
  const rec = read(dir);
  assert.equal(rec.sessionId, SID);
  assert.equal(rec.status, 'idle');
  rmSync(dir, { recursive: true, force: true });
});

// Korrigiert am 2026-09-13: `Stop` setzt `waiting`, nicht `idle` -- ein
// beendeter Turn heisst "wartet auf Reaktion", nicht "nichts los" (siehe
// Kommentar im Hook-Skript und docs/HISTORIE.md).
test('SessionStart -> UserPromptSubmit -> Stop endet waiting', () => {
  const dir = fresh();
  fire(dir, 'SessionStart');
  fire(dir, 'UserPromptSubmit');
  assert.equal(read(dir).status, 'working');
  fire(dir, 'Stop');
  assert.equal(read(dir).status, 'waiting');
  rmSync(dir, { recursive: true, force: true });
});

// Die Reaktion, die das Gelb wieder abraeumt, ist der naechste Prompt in
// derselben Session -- nicht ein Blick auf die Karte.
test('Stop -> UserPromptSubmit endet working (die Reaktion raeumt das Gelb ab)', () => {
  const dir = fresh();
  fire(dir, 'SessionStart');
  fire(dir, 'UserPromptSubmit');
  fire(dir, 'Stop');
  assert.equal(read(dir).status, 'waiting');
  fire(dir, 'UserPromptSubmit');
  assert.equal(read(dir).status, 'working');
  rmSync(dir, { recursive: true, force: true });
});

test('since wechselt beim Uebergang working -> waiting', () => {
  const dir = fresh();
  fire(dir, 'SessionStart');
  fire(dir, 'UserPromptSubmit');
  const workingSince = read(dir).since;
  fire(dir, 'Stop');
  const waitingRec = read(dir);
  assert.equal(waitingRec.status, 'waiting');
  assert.notEqual(waitingRec.since, workingSince, 'ein echter Statuswechsel muss since erneuern');
  rmSync(dir, { recursive: true, force: true });
});

// R24: PermissionRequest ist eindeutig eine Abfrage -- eigener Zustand
// `prompt`, nicht mehr das allgemeine `waiting`.
test('PermissionRequest setzt prompt', () => {
  const dir = fresh();
  fire(dir, 'PermissionRequest');
  assert.equal(read(dir).status, 'prompt');
  rmSync(dir, { recursive: true, force: true });
});

// Notification feuert fuer dieselbe Abfrage zusaetzlich, mit
// notification_type=permission_prompt (gemessen, siehe Spec) -- auch das ist
// `prompt`. Jede andere (oder fehlende) notification_type bleibt `waiting`.
test('Notification mit notification_type=permission_prompt setzt prompt', () => {
  const dir = fresh();
  fire(dir, 'Notification', { notification_type: 'permission_prompt' });
  assert.equal(read(dir).status, 'prompt');
  rmSync(dir, { recursive: true, force: true });
});

test('Notification ohne notification_type setzt waiting', () => {
  const dir = fresh();
  fire(dir, 'Notification');
  assert.equal(read(dir).status, 'waiting');
  rmSync(dir, { recursive: true, force: true });
});

test('Notification mit unbekanntem notification_type setzt waiting, kein fuenftes Wort', () => {
  const dir = fresh();
  fire(dir, 'Notification', { notification_type: 'idle_reminder' });
  assert.equal(read(dir).status, 'waiting');
  rmSync(dir, { recursive: true, force: true });
});

test('since bleibt stehen, solange der Status gleich bleibt', () => {
  const dir = fresh();
  fire(dir, 'UserPromptSubmit');
  const first = read(dir).since;
  fire(dir, 'UserPromptSubmit');
  assert.equal(read(dir).since, first, 'since darf sich ohne Statuswechsel nicht aendern');
  fire(dir, 'Stop');
  assert.notEqual(read(dir).since, first, 'bei echtem Wechsel muss since neu sein');
  rmSync(dir, { recursive: true, force: true });
});

test('SessionEnd loescht Statusdatei und Marker-Verzeichnis', () => {
  const dir = fresh();
  fire(dir, 'SessionStart');
  fire(dir, 'SubagentStart', { agent_id: 'a1' });
  fire(dir, 'SessionEnd');
  assert.equal(existsSync(join(dir, 'agent-colony', `${SID}.json`)), false);
  assert.equal(existsSync(markerDir(dir)), false, 'Marker-Verzeichnis muss mit aufgeraeumt werden');
  rmSync(dir, { recursive: true, force: true });
});

test('Payload ohne Session-ID schreibt nichts und bricht nicht ab', () => {
  const dir = fresh();
  execFileSync('bash', [HOOK, 'Stop'], {
    input: '{"cwd":"/home/user/x"}',
    env: { ...process.env, XDG_RUNTIME_DIR: dir },
  });
  assert.equal(existsSync(join(dir, 'agent-colony')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('kaputtes Payload liefert trotzdem Exit 0', () => {
  const dir = fresh();
  const out = execFileSync('bash', [HOOK, 'Stop'], {
    input: 'das ist kein JSON',
    env: { ...process.env, XDG_RUNTIME_DIR: dir },
  });
  assert.ok(out !== null, 'kein Wurf heisst Exit 0');
  rmSync(dir, { recursive: true, force: true });
});

// R11: SessionStart feuert auch mitten in einer laufenden Session, wenn sie
// kompaktiert (source=compact). Eine arbeitende Session darf dabei nicht auf
// idle zurueckfallen -- nur ein echter Sessionstart (source != compact)
// setzt idle.
test('SessionStart mit source=compact laesst Status und since unangetastet (R11)', () => {
  const dir = fresh();
  fire(dir, 'UserPromptSubmit');
  const before = read(dir);
  assert.equal(before.status, 'working');
  fire(dir, 'SessionStart', { source: 'compact' });
  const afterCompact = read(dir);
  assert.equal(afterCompact.status, 'working', 'compact darf eine arbeitende Session nicht auf idle zuruecksetzen');
  assert.equal(afterCompact.since, before.since, 'since darf bei compact nicht neu gesetzt werden');
  fire(dir, 'SessionStart', { source: 'startup' });
  assert.equal(read(dir).status, 'idle', 'ein echter Sessionstart setzt weiterhin idle');
  rmSync(dir, { recursive: true, force: true });
});

// R16: Zaehler ersetzt durch Markerdateien je agent_id -- kein Read-Modify-
// Write auf einer gemeinsamen Datei mehr, das bei parallelen Subagenten
// Updates verliert.
test('SubagentStart legt eine Markerdatei an, SubagentStop entfernt sie', () => {
  const dir = fresh();
  fire(dir, 'SubagentStart', { agent_id: 'a1' });
  assert.deepEqual(markers(dir), ['a1']);
  fire(dir, 'SubagentStart', { agent_id: 'a2' });
  assert.deepEqual(markers(dir).sort(), ['a1', 'a2']);
  fire(dir, 'SubagentStop', { agent_id: 'a1' });
  assert.deepEqual(markers(dir), ['a2']);
  fire(dir, 'SubagentStop', { agent_id: 'a2' });
  assert.deepEqual(markers(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test('SubagentStop ohne vorhandenen Marker bricht nicht ab', () => {
  const dir = fresh();
  fire(dir, 'SubagentStop', { agent_id: 'nie-gestartet' });
  assert.deepEqual(markers(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test('SubagentStart/SubagentStop lassen Status und since komplett unberuehrt', () => {
  const dir = fresh();
  fire(dir, 'UserPromptSubmit');
  const before = read(dir);
  fire(dir, 'SubagentStart', { agent_id: 'a1' });
  fire(dir, 'SubagentStop', { agent_id: 'a1' });
  const after = read(dir);
  assert.equal(after.status, before.status);
  assert.equal(after.since, before.since, 'Subagenten-Ereignisse duerfen since nicht neu setzen');
  rmSync(dir, { recursive: true, force: true });
});

test('SubagentStart/SubagentStop ohne agent_id tun nichts und brechen nicht ab', () => {
  const dir = fresh();
  execFileSync('bash', [HOOK, 'SubagentStart'], {
    input: JSON.stringify({ session_id: SID, cwd: '/home/user/x' }),
    env: { ...process.env, XDG_RUNTIME_DIR: dir },
  });
  assert.equal(existsSync(markerDir(dir)), false);
  rmSync(dir, { recursive: true, force: true });
});

test('Pfadsicherheit: session_id mit unerlaubten Zeichen schreibt nichts', () => {
  const dir = fresh();
  execFileSync('bash', [HOOK, 'SessionStart'], {
    input: JSON.stringify({ session_id: '../evil', cwd: '/home/user/x' }),
    env: { ...process.env, XDG_RUNTIME_DIR: dir },
  });
  assert.equal(existsSync(join(dir, 'agent-colony')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('Pfadsicherheit: agent_id mit unerlaubten Zeichen legt keinen Marker an', () => {
  const dir = fresh();
  fire(dir, 'SubagentStart', { agent_id: '../evil' });
  assert.deepEqual(markers(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

// Genau der Fall, den der Reviewer nachgestellt hat: 20 parallele
// SubagentStart mit verschiedenen agent_id ergaben mit dem alten Zaehler
// "subagents: 6" statt 20 (Lost Update). Mit Markerdateien muss die Anzahl
// exakt stimmen, weil jedes Ereignis nur seine eigene Datei anlegt.
test('SubagentStart parallel mit verschiedenen agent_id erzeugt exakt so viele Marker (Rennen)', async () => {
  const dir = fresh();
  const N = 20;
  const ids = Array.from({ length: N }, (_, i) => `agent-${i}`);
  await Promise.all(ids.map((agent_id) => fireAsync(dir, 'SubagentStart', { agent_id })));
  const result = markers(dir);
  assert.equal(result.length, N, `erwartet ${N} Marker, erhalten ${result.length}`);
  assert.deepEqual(result.sort(), [...ids].sort());
  rmSync(dir, { recursive: true, force: true });
});
