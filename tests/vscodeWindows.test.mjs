/* Die Fensterwahl aus `code -s`. Reine Funktionen ihrer Eingabe, also
 * Fixtures — die Titel stammen aus echten Laeufen am 2026-09-14.
 *
 * Wichtig ist hier nicht der Treffer, sondern die Verweigerung: ein falsch
 * gewaehltes Fenster schiebt einem fremden Projekt eine neue Claude-Instanz
 * unter (docs/FALLEN.md, "Werkzeuge"). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickWindow, twinsOf, windowsFor } from '../src/vscode.mjs';

const LIST = [
  { id: 11, title: 'Weekly report flow… - automation [WSL: Ubuntu] - Visual Studio Code' },
  { id: 4, title: '● Ich möchte … • Untitled-1 - Visual Studio Code' },
  { id: 10, title: 'Agent sessions anklickba… - agent-colony [WSL: Ubuntu] - Visual Studio Code' },
];

test('findet das Fenster mit dem Ordner im Titel', () => {
  const hits = windowsFor('/home/user/projects/agent-colony', 'Ubuntu', LIST);
  assert.deepEqual(hits.map((w) => w.id), [10]);
});

test('Fenster ohne Tab im Titel zaehlt ebenfalls', () => {
  const list = [{ id: 7, title: 'agent-colony [WSL: Ubuntu] - Visual Studio Code' }];
  assert.deepEqual(windowsFor('/x/agent-colony', 'Ubuntu', list).map((w) => w.id), [7]);
});

test('ein Fenster ohne WSL-Remote kommt nie in Frage', () => {
  // Es sieht das Linux-Dateisystem nicht; dort entstand im Test die falsche
  // frische Session.
  const list = [{ id: 4, title: 'x - agent-colony - Visual Studio Code' }];
  assert.deepEqual(windowsFor('/x/agent-colony', 'Ubuntu', list), []);
});

test('eine fremde Distro kommt nie in Frage', () => {
  assert.deepEqual(windowsFor('/x/automation', 'Debian', LIST), []);
});

test('ein Praefix des Ordnernamens trifft nicht', () => {
  const list = [{ id: 3, title: 'a - mein-agent-colony [WSL: Ubuntu] - Visual Studio Code' }];
  assert.deepEqual(windowsFor('/x/agent-colony', 'Ubuntu', list), []);
});

test('kein Fenster: null, damit der Aufrufer eines oeffnet', () => {
  assert.equal(pickWindow('/x/frisch', 'Ubuntu', LIST, []), null);
});

test('zwei Fenster gleichen Namens: lieber gar nichts', () => {
  const list = [
    { id: 1, title: 'a - production [WSL: Ubuntu] - Visual Studio Code' },
    { id: 2, title: 'b - production [WSL: Ubuntu] - Visual Studio Code' },
  ];
  assert.throws(() => pickWindow('/c/deployments/production', 'Ubuntu', list, []), /2 Fenster/);
});

test('ein Treffer, aber der Name ist auf der Karte doppelt: lieber gar nichts', () => {
  // deployments/production und deployments/shared/production gab es auf der
  // Maschine des Autors wirklich. Der Titel nennt nur "production".
  const list = [{ id: 1, title: 'a - production [WSL: Ubuntu] - Visual Studio Code' }];
  assert.throws(
    () =>
      pickWindow('/c/deployments/production', 'Ubuntu', list, [
        '/c/deployments/production',
        '/c/deployments/shared/production',
      ]),
    /so heisst auch/,
  );
});

test('Zwillinge stoeren nur, wenn ein Fenster offen ist', () => {
  // Ohne Treffer wird ein Fenster auf den richtigen Pfad geoeffnet; welcher
  // Zwilling gemeint ist, steht dann nicht zur Debatte.
  assert.equal(
    pickWindow('/c/deployments/production', 'Ubuntu', [], [
      '/c/deployments/production',
      '/c/deployments/shared/production',
    ]),
    null,
  );
});

test('twinsOf nennt nur die anderen', () => {
  assert.deepEqual(twinsOf('/a/production', ['/a/production', '/b/production', '/c/x']), [
    '/b/production',
  ]);
});
