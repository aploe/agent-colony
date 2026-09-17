/* Eine Agenten-Session in VS Code oeffnen.
 *
 * Die einzige Stelle im Projekt, die fremde Prozesse startet. Alles andere
 * hier liest nur. Der Weg hat drei Schritte, und jeder einzelne ist noetig:
 *
 *   1. `code <ordner>` — oeffnet ein Fenster fuer den Ordner oder holt das
 *      bestehende nach vorn. NIE mit `-r`/`--reuse-window`: das wuerde ein
 *      fremdes Fenster auf diesen Ordner umwidmen und die Sitzung darin
 *      verlieren. Ohne Schalter widmet VS Code nie um.
 *   2. `code -s` — nennt die offenen Fenster als `window [n] (<titel>)`. Die
 *      Zahl ist die Fenster-ID, die Schritt 3 braucht.
 *   3. `vscode://anthropic.claude-code/open?session=<uuid>&windowId=<n>` —
 *      die Claude-Code-Extension registriert diesen UriHandler und oeffnet
 *      die Session als Tab.
 *
 * Warum `windowId` unverzichtbar ist (gemessen am 2026-09-14, Extension
 * 2.1.270): ohne den Parameter liefert VS Code den URI an ein beliebiges
 * Fenster aus. Im Test landete die Session eines Projekts im Fenster eines
 * voellig anderen; dort schlug die Wiederherstellung fehl ("restore_declined")
 * und die Extension startete stattdessen eine FRISCHE Claude-Instanz im cwd
 * jenes Fensters. Mit `windowId=<n>` trifft der Aufruf genau das gemeinte
 * Fenster. `windowId=_blank` gibt es auch, erzwingt aber ein leeres Fenster
 * ohne WSL-Remote — dort findet die Extension die Session nicht.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/* Gibt VS Code fuer einen Windows-Roundtrip: `code -s` und `code <ordner>`
 * laufen ueber wsl.exe zurueck zur Windows-Instanz und brauchen je nach Last
 * ein bis zwei Sekunden. */
const CLI_TIMEOUT_MS = 20_000;

/* Ein neu geoeffnetes Fenster taucht erst nach einigen Sekunden in `code -s`
 * auf; ein kaltes VS Code braucht laenger. Danach ist das Fenster zwar da,
 * die Extension aber noch nicht aktiv — der Puffer deckt das ab. */
const WINDOW_WAIT_MS = 30_000;
const WINDOW_POLL_MS = 700;
const EXTENSION_WARMUP_MS = 2_500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Die remote-cli des WSL-Servers, nicht `code` vom PATH: der Server laeuft
 * oft detached aus einem Skript, wo der PATH des VS-Code-Terminals fehlt. Der
 * Ordner unter bin/ traegt den Commit-Hash der VS-Code-Version und wechselt
 * bei jedem Update, deshalb der jeweils neueste statt eines festen Pfades.
 * `vscodeCli` in der Config schlaegt die Suche. */
async function findCli(cfg) {
  if (cfg?.vscodeCli) return cfg.vscodeCli;
  const base = join(homedir(), '.vscode-server', 'bin');
  let entries = [];
  try {
    entries = await readdir(base);
  } catch {
    throw new Error(`kein VS-Code-Server unter ${base} — laeuft VS Code mit WSL-Remote?`);
  }
  const found = [];
  for (const e of entries) {
    const cli = join(base, e, 'bin', 'remote-cli', 'code');
    try {
      found.push({ cli, at: (await stat(cli)).mtimeMs });
    } catch {
      // Ordner ohne remote-cli (Reste alter Versionen) still uebergehen
    }
  }
  if (!found.length) throw new Error(`keine remote-cli unter ${base}/*/bin/remote-cli/code`);
  found.sort((a, b) => b.at - a.at);
  return found[0].cli;
}

/* Die offenen Fenster als [{ id, title }]. `code -s` schreibt neben den
 * Fenstern die ganze Prozessliste; nur die Zeilen mit `window [n] (...)`
 * zaehlen. */
async function windows(cli) {
  const { stdout } = await run(cli, ['-s'], { timeout: CLI_TIMEOUT_MS });
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/window \[(\d+)\] \((.*)\)\s*$/);
    if (m) out.push({ id: Number(m[1]), title: m[2] });
  }
  return out;
}

/* Alle Fenster, deren Titel auf diesen Ordner passt.
 *
 * Der Fenstertitel ist die einzige Auskunft, die `code -s` ueber den Inhalt
 * eines Fensters gibt, und er nennt nur den Basisnamen des Ordners:
 * "<tab> - <ordner> [WSL: <distro>] - Visual Studio Code". Deshalb eine
 * Liste und kein Treffer: wer raet, welcher von zwei gleichnamigen Ordnern
 * gemeint ist, schiebt im Zweifel einem fremden Projekt eine neue Session
 * unter (siehe Kopf dieser Datei). Entschieden wird in openSession.
 *
 * Ein Fenster, das den ELTERNordner offen hat, gilt als "nicht offen". Dann
 * entsteht ein zweites Fenster fuer den Unterordner. Unbequem, aber sicher.
 *
 * Nur WSL-Fenster der eigenen Distro kommen in Frage. Ein Fenster ohne
 * WSL-Remote sieht das Linux-Dateisystem nicht und findet die Session nicht;
 * genau dort entstand im Test die falsche frische Session. */
function windowsFor(path, distro, list) {
  const tail = `${basename(path)} [WSL: ${distro}] - Visual Studio Code`;
  return list.filter((w) => w.title === tail || w.title.endsWith(` - ${tail}`));
}

/* Andere bekannte Ordner, die denselben Basisnamen tragen — auf dieser
 * Maschine heute etwa `deployments/production` und
 * `deployments/shared/production`. Gibt es sie, sagt ein Titeltreffer nicht
 * mehr, welcher der beiden im Fenster liegt. */
function twinsOf(path, knownPaths) {
  const name = basename(path);
  return knownPaths.filter((p) => p !== path && basename(p) === name);
}

/* Genau ein Fenster, oder ein Fehler, der sagt warum nicht. */
function pickWindow(path, distro, list, knownPaths) {
  const hits = windowsFor(path, distro, list);
  if (!hits.length) return null;
  const name = basename(path);
  if (hits.length > 1) {
    throw new Error(`${hits.length} Fenster zeigen "${name}" — welches gemeint ist, sagt der Titel nicht`);
  }
  const twins = twinsOf(path, knownPaths);
  if (twins.length) {
    throw new Error(
      `der Fenstertitel nennt nur "${name}", und so heisst auch ${twins.join(', ')}` +
        ' — bitte das Fenster selbst oeffnen',
    );
  }
  return hits[0];
}

/* Fenster oeffnen oder nach vorn holen, dann die Session als Tab.
 * Liefert { window, reused, title }; jeder Fehlschlag wirft mit Klartext. */
async function openSession({ path, sessionId, distro, cfg, knownPaths = [] }) {
  if (!UUID.test(sessionId ?? '')) throw new Error('keine gueltige Session-ID');
  if (!distro) throw new Error('keine WSL-Distro bekannt (config.wslDistro)');

  const cli = await findCli(cfg);
  // Erst pruefen, dann oeffnen: bei einem mehrdeutigen Titel soll gar nichts
  // passieren, nicht das Falsche.
  const before = pickWindow(path, distro, await windows(cli), knownPaths);

  // Ohne Schalter: oeffnet ein neues Fenster oder fokussiert das bestehende.
  await run(cli, [path], { timeout: CLI_TIMEOUT_MS });

  let win = before;
  if (!win) {
    const until = Date.now() + WINDOW_WAIT_MS;
    while (!win && Date.now() < until) {
      await wait(WINDOW_POLL_MS);
      // Vorher gab es kein Fenster mit diesem Namen; was jetzt auftaucht, ist
      // das eben geoeffnete. Ein zweites waere ein fremdes, das in derselben
      // Sekunde aufging — dann wirft pickWindow, und das ist richtig so.
      win = pickWindow(path, distro, await windows(cli), knownPaths);
    }
    if (!win) throw new Error(`Fenster fuer ${path} kam nicht hoch`);
    // Das Fenster steht, die Extension laedt noch. Ohne diesen Puffer geht
    // der URI ins Leere.
    await wait(EXTENSION_WARMUP_MS);
  }

  const uri =
    'vscode://anthropic.claude-code/open' +
    `?session=${encodeURIComponent(sessionId)}&windowId=${win.id}`;
  try {
    await run('wslview', [uri], { timeout: CLI_TIMEOUT_MS });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('wslview fehlt (Paket wslu) — URI nicht ausloesbar');
    throw err;
  }

  return { window: win.id, reused: Boolean(before), title: win.title };
}

export { findCli, openSession, pickWindow, twinsOf, windowsFor, windows, UUID };
