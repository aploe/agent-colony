import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';
import { collect, loadConfig } from './collect.mjs';
import { openSession, UUID } from './vscode.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = await loadConfig();

// Fehlt das Verzeichnis, liefert die Erhebung eine leere Karte, und die sieht
// aus wie "nichts los". Einmal beim Start sagen, woran es liegt.
if (!existsSync(cfg.claudeProjectsDir)) {
  console.warn(
    `Warnung: ${cfg.claudeProjectsDir} existiert nicht. Die Karte bleibt leer, bis Claude Code ` +
      `dort eine Session angelegt hat oder claudeProjectsDir in config/colony.local.json stimmt.`,
  );
}

/* Port-Override fuer Wegwerf-Server: `--port N` (0 = das System waehlt einen
 * freien Port) oder die Umgebungsvariable COLONY_PORT. Damit kann ein Agent
 * oder scripts/drive.mjs einen eigenen Server neben dem laufenden starten,
 * ohne config/colony.local.json anzufassen — die Datei gehoert dem Checkout,
 * nicht dem Aufrufer. Vorher mussten Subagenten dafuer die Config umschreiben
 * oder den Server des Controllers uebernehmen; beides kollidierte (2026-09-11). */
const argPort = process.argv.indexOf('--port');
const portOverride = argPort > -1 ? process.argv[argPort + 1] : process.env.COLONY_PORT;
if (portOverride !== undefined && portOverride !== '') cfg.port = Number(portOverride);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Ohne diesen Eintrag gingen die Frontend-Module als octet-stream raus und
  // der Browser weigert sich, sie als Modul auszufuehren — ohne sichtbaren
  // Fehler ausser einer leeren Seite.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Shoelace-Komponenten holen ihre Icons als SVG aus dist/assets/
  '.svg': 'image/svg+xml',
  // Kit-Skin der 3D-Ansicht (public/assets/kit): glTF-Text, glTF-Binaer,
  // Puffer, Atlas-Textur. fetch() naehme auch octet-stream — aber der
  // Fehlerfall im Netzwerk-Tab waere dann nicht zu lesen.
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
};

/* Statische Wurzeln als URL-Praefix -> Verzeichnis, laengster Praefix zuerst.
 *
 * `/vendor/` zeigt direkt auf node_modules statt auf eingecheckte Kopien: die
 * Versionen stehen damit allein in package.json und koennen nicht mit einem
 * mitcommitteten Build auseinanderlaufen.
 *
 * Ohne Bundler laedt der Browser die ESM-Dateien einzeln, und ein Paket
 * importiert seine Nachbarn unter blankem Namen (Shoelace holt `lit` und
 * `@floating-ui/dom`, three seine Addons als "three"). Die Importmap in
 * public/index.html loest diese Namen auf — sie ist die einzige Stelle, an der
 * Paketnamen stehen, deshalb hier eine Wurzel statt eines Mounts pro Paket.
 *
 * Ausgeliefert wird damit der ganze node_modules-Baum. Auf einem Server, der
 * nur auf localhost lauscht (Vorgabe, siehe `listen` unten) und
 * ausschliesslich liest, ist das vertretbar; der ../-Schutz unten gilt
 * weiter. Fuer eine Bindung an eine andere Adresse waere es das nicht, darum
 * warnt der Start dann. */
const MOUNTS = [
  ['/vendor/', join(root, 'node_modules')],
  ['/', join(root, 'public')],
];

// Ein Refresh scannt das Vault und die Session-Verzeichnisse. Der Cache
// verhindert, dass mehrere offene Tabs das vervielfachen. Halbes
// Poll-Intervall: kurz genug, dass ein Tab nie zwei Runden dieselbe Antwort
// sieht, lang genug, dass fuenf Tabs nicht fuenfmal erheben.
const CACHE_MS = ((cfg.pollSeconds ?? 3) * 1000) / 2;
let cache = { at: 0, state: null };
async function state() {
  if (Date.now() - cache.at < CACHE_MS && cache.state) return cache.state;
  cache = { at: Date.now(), state: await collect(cfg) };
  return cache.state;
}

/* Der Endpoint unten startet Prozesse — als Einziger hier. Darum drei enge
 * Leitplanken, jede gegen einen eigenen Fehlgriff:
 *
 *  - nur Verbindungen vom eigenen Rechner. Die Vorgabe bindet ohnehin nur an
 *    127.0.0.1 (unten bei `listen`); die Pruefung bleibt fuer den Fall, dass
 *    jemand `host` auf eine Netzadresse stellt. Ein Geraet im selben Netz
 *    darf auch dann die Karte lesen, aber keine Fenster auf diesem Rechner
 *    aufreissen.
 *  - der Pfad muss aus der eigenen Erhebung stammen. Der Browser darf einen
 *    Ordner nennen, nicht erfinden.
 *  - execFile statt Shell (in vscode.mjs), also keine Metazeichen-Frage.
 */
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocal = (req) => LOCAL.has(req.socket.remoteAddress ?? '');

/* Die Adresspruefung allein reicht nicht: der Browser, der die Karte zeigt,
 * laeuft auf der Windows-Seite und kommt ueber das WSL-Forwarding als
 * 127.0.0.1 an — eine beliebige fremde Seite in demselben Browser also auch.
 * Zwei Riegel dagegen:
 *
 *  - `content-type: application/json` ist kein "simple request"; ein
 *    cross-site fetch darauf zwingt einen Preflight, den dieser Server nicht
 *    beantwortet. Ein Formular-POST kann den Typ gar nicht setzen.
 *  - ein `Origin`, der nicht die eigene Adresse ist, fliegt raus. Geprueft
 *    wird gegen den Host der Anfrage, nicht gegen eine Liste mit localhost:
 *    wer die Karte ueber 127.0.0.1 oder einen anderen Namen fuer den eigenen
 *    Rechner aufruft, soll nicht ausgesperrt werden, waehrend fremde
 *    Herkunft weiter scheitert. */
function sameSite(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  return (req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json';
}

/* Hoechstens 4 KB, sonst abbrechen: der Body traegt zwei kurze Felder. */
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        // Erst ablehnen, dann abbrechen: ein zerstoerter Socket kommt beim
        // Aufrufer als "fetch failed" an, und das sagt ihm nichts.
        reject(Object.assign(new Error('Body zu gross'), { tooBig: true }));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* Alle Ordner, die die Erhebung kennt: Felder UND ihre members — ein Feld
 * fasst Worktrees und Unterordner desselben Repos zusammen, und der Agent
 * kann in jedem davon sitzen. `exists: false` faellt durch: ein Fenster auf
 * ein verschwundenes Verzeichnis nuetzt niemandem. Die Liste ist zweierlei:
 * Whitelist fuer den Pfad und Grundlage fuer die Zwillingspruefung in
 * vscode.mjs (zwei Ordner gleichen Basisnamens). */
function paths(st) {
  const out = [];
  for (const planet of st.planets ?? []) {
    for (const hex of planet.hexes ?? []) {
      if (hex.exists === false) continue;
      for (const p of [hex.path, ...(hex.members ?? [])]) if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(await state()));
      return;
    }
    // Klick auf eine Agentenzeile im Panel: Session als Tab in VS Code. Warum
    // der Server das tut und nicht der Browser mit einem vscode:-Link: das
    // Zielfenster muss in der URI stehen (vscode.mjs erklaert, warum), und
    // seine ID kennt nur, wer `code -s` ausfuehren kann.
    if (url.pathname === '/api/open-session') {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST') return send(405, { ok: false, error: 'nur POST' });
      if (!isLocal(req)) return send(403, { ok: false, error: 'nur lokal' });
      if (!sameSite(req)) return send(403, { ok: false, error: 'fremde Herkunft' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.tooBig) return send(413, { ok: false, error: 'Body zu gross' });
        return send(400, { ok: false, error: 'Body ist kein JSON' });
      }
      const { path, sessionId } = body ?? {};
      const st = await state();
      const known = paths(st);
      if (typeof path !== 'string' || !known.includes(path)) {
        // Getrennte Meldungen, weil sie zu getrennten Ursachen gehoeren: ein
        // Feld, dessen Verzeichnis verschwunden ist, steht in der Erhebung —
        // "unbekannt" waere dafuer die falsche Auskunft.
        const gone = (st.planets ?? []).some((p) =>
          (p.hexes ?? []).some((h) => h.exists === false && h.path === path),
        );
        return send(400, { ok: false, error: gone ? 'Verzeichnis fehlt' : 'unbekannter Pfad' });
      }
      // Formfehler sind Sache des Aufrufers, nicht der Maschine: 400 statt der
      // 500, die der Wurf aus openSession sonst ergaebe.
      if (!UUID.test(sessionId ?? '')) {
        return send(400, { ok: false, error: 'keine gueltige Session-ID' });
      }
      try {
        const opened = await openSession({
          path,
          sessionId,
          distro: st.config?.wslDistro,
          cfg,
          knownPaths: known,
        });
        return send(200, { ok: true, ...opened });
      } catch (err) {
        // Klartext bis in die Oberflaeche: "kein Fenster", "wslview fehlt",
        // "keine gueltige Session-ID" sind Dinge, die der Leser abstellen
        // kann — eine 500 ohne Text waere hier nutzlos.
        return send(500, { ok: false, error: err.message });
      }
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const [prefix, dir] = MOUNTS.find(([p]) => rel.startsWith(p));
    // normalize + Prefix-Check, damit ../ nicht aus der Wurzel herausfuehrt
    const file = join(dir, normalize(rel.slice(prefix.length - 1)));
    if (!file.startsWith(dir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    const notFound = err.code === 'ENOENT';
    res.writeHead(notFound ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(notFound ? 'not found' : `error: ${err.message}`);
    if (!notFound) console.error(err);
  }
});

/* Nur an die Loopback-Adresse binden, solange die Config nichts anderes sagt.
 * `/api/state` traegt alle Repo-Pfade, Branches und Aufgaben der Subagenten,
 * `/vendor/` den ganzen node_modules-Baum; beides soll auf einer fremden
 * Maschine nicht im lokalen Netz lesbar sein. Bis 2026-09-17 band der Server
 * an alle Adressen, in der Annahme, das WSL-Forwarding zum Windows-Browser
 * brauche das. Gemessen (WSL2, NAT-Modus): ein Server nur auf 127.0.0.1
 * antwortet `curl.exe` und Edge auf der Windows-Seite unter localhost und
 * 127.0.0.1; nur `[::1]` kommt nicht an. Wer die Karte bewusst ins Netz
 * stellt, setzt `host`. */
const host = cfg.host ?? '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Den tatsaechlichen Port ausgeben, nicht den gewuenschten: bei `--port 0`
// steht er erst nach dem Binden fest, und scripts/drive.mjs liest ihn hier ab.
server.listen(cfg.port, host, () => {
  console.log(`Agent Colony -> http://localhost:${server.address().port}`);
  if (!LOOPBACK.has(host)) {
    console.warn(
      `Warnung: host ist ${host}. Jeder, der diese Adresse erreicht, liest /api/state ` +
        `(alle Pfade, Branches, Aufgaben) und /vendor/. Mit der Vorgabe 127.0.0.1 lauscht er nur lokal.`,
    );
  }
});
