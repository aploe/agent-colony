/* Eine Agenten-Session in VS Code oeffnen. Socket discovery: agent-tower src/vscode.mjs, commit 3520192.
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

/* Socket discovery, ported from agent-tower src/vscode.mjs, commit 3520192.
 *
 * The remote CLI refuses to run without `VSCODE_IPC_HOOK_CLI` ("Command is only available in
 * WSL or inside a Visual Studio Code terminal"). A server started outside a VS Code terminal
 * has none, so it picks a live `vscode-ipc-*.sock` itself. Measured in Agent Tower: the newest
 * live socket works, old dead ones list nothing. A socket counts when `code -s` through it
 * lists at least one `window [n]`. Order: the env var if set, then the cached socket, then the
 * rest newest first. */
const LIST_TIMEOUT_MS = 8_000;

async function listSockets() {
  const dir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^vscode-ipc-.*\.sock$/.test(n)) continue;
    const p = join(dir, n);
    try {
      out.push({ path: p, mtimeMs: (await stat(p)).mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

const defaultDeps = { run, sockets: listSockets };

/* The socket that worked last time; dropped when it stops listing windows. */
let cachedSocket = null;

function resetSocketCache() {
  cachedSocket = null;
}

/* The open windows as [{ id, title }] through one socket (null = the inherited environment).
 * `code -s` prints the whole process list next to the windows; only the lines with
 * `window [n] (...)` count. Never throws: an error or an empty list means a dead socket. */
async function windowsVia(deps, cli, socket) {
  let stdout;
  try {
    ({ stdout } = await deps.run(cli, ['-s'], {
      env: socket ? { ...process.env, VSCODE_IPC_HOOK_CLI: socket } : process.env,
      timeout: LIST_TIMEOUT_MS,
    }));
  } catch {
    return null;
  }
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/window \[(\d+)\] \((.*)\)\s*$/);
    if (m) out.push({ id: Number(m[1]), title: m[2] });
  }
  return out.length ? out : null;
}

/* { socket, list } from the first working socket; `socket` is null when the inherited
 * environment works. Throws when none does. */
async function findWindows(deps, cli) {
  if (process.env.VSCODE_IPC_HOOK_CLI) {
    const list = await windowsVia(deps, cli, null);
    if (list) return { socket: null, list };
  }
  let dead = null;
  if (cachedSocket) {
    const list = await windowsVia(deps, cli, cachedSocket);
    if (list) return { socket: cachedSocket, list };
    dead = cachedSocket;
    cachedSocket = null;
  }
  const entries = [...(await deps.sockets())].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { path } of entries) {
    if (path === dead) continue;
    const list = await windowsVia(deps, cli, path);
    if (list) {
      cachedSocket = path;
      return { socket: path, list };
    }
  }
  throw new Error('kein lebender VS-Code-Socket gefunden — ist VS Code mit WSL-Remote offen?');
}

/* The open windows as a list. */
async function windows(cli, deps = defaultDeps) {
  return (await findWindows(deps, cli)).list;
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
async function openSession({ path, sessionId, distro, cfg, knownPaths = [], deps = defaultDeps }) {
  if (!UUID.test(sessionId ?? '')) throw new Error('keine gueltige Session-ID');
  if (!distro) throw new Error('keine WSL-Distro bekannt (config.wslDistro)');

  const cli = await findCli(cfg);
  // Erst pruefen, dann oeffnen: bei einem mehrdeutigen Titel soll gar nichts
  // passieren, nicht das Falsche.
  const found = await findWindows(deps, cli);
  const before = pickWindow(path, distro, found.list, knownPaths);

  // Ohne Schalter: oeffnet ein neues Fenster oder fokussiert das bestehende.
  await deps.run(cli, [path], {
    env: found.socket ? { ...process.env, VSCODE_IPC_HOOK_CLI: found.socket } : process.env,
    timeout: CLI_TIMEOUT_MS,
  });

  let win = before;
  if (!win) {
    const until = Date.now() + WINDOW_WAIT_MS;
    while (!win && Date.now() < until) {
      await wait(WINDOW_POLL_MS);
      // Vorher gab es kein Fenster mit diesem Namen; was jetzt auftaucht, ist
      // das eben geoeffnete. Ein zweites waere ein fremdes, das in derselben
      // Sekunde aufging — dann wirft pickWindow, und das ist richtig so.
      win = pickWindow(path, distro, await windows(cli, deps), knownPaths);
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

export { findCli, findWindows, openSession, pickWindow, resetSocketCache, twinsOf, windowsFor, windows, UUID };
