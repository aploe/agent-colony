#!/usr/bin/env node
/* Browser-Harness fuer die Karte: startet bei Bedarf einen eigenen Server auf
 * einem freien Port, faehrt die Seite mit Playwright und bietet die Handgriffe,
 * die jede Pruefung braucht — Screenshot, Planet wechseln, Zuklappen, Umordnen,
 * Chip-Hover (2D; der 3D-Chip ist ein DOM-Knoten und klickt sich selbst),
 * Figuren injizieren, Positionen (renderer-uebergreifend: screenOf/hexScreenPos),
 * HUD-Hoehe auslesen und Skin wechseln (`--skin kit`, `h.skin`, `h.setSkin`).
 *
 * Warum ein Skript und kein Agent: am 2026-09-11 haben sechs Subagenten genau
 * diesen Harness je von vorn gebaut. Er gehoert ins Repo, nicht in Prompts.
 *
 * Server-Besitz: dieses Skript startet seinen Server selbst (`--port 0`, das
 * System waehlt), beendet ihn per PID und fasst nie einen anderen an. Wer gegen
 * einen laufenden Server pruefen will, gibt `--port N` an — dann wird keiner
 * gestartet und keiner beendet.
 *
 * Playwright ist absichtlich keine Projekt-Dependency (ein Pruefwerkzeug ist
 * kein Laufzeitpaket). `playwright-core` wird aus node_modules aufgeloest, sonst
 * aus der globalen nvm-Installation; Chromium aus ~/.cache/ms-playwright oder
 * COLONY_CHROME. Fehlt etwas, sagt das Skript, was.
 *
 * Aufruf:
 *   node scripts/drive.mjs shot <planet> out.png              Screenshot, eigener Server
 *   node scripts/drive.mjs shot <planet> out.png --port 4173  gegen laufenden Server
 *   node scripts/drive.mjs run szenario.mjs [--planet <id>] [--port N] [--mode 3d] [--skin kit]
 *
 * Ein Szenario ist eine .mjs-Datei mit
 *   export default async ({ page, h, server }) => { ... }
 * und bekommt die Helfer `h` (siehe unten), die Playwright-Page und
 * { port, url }. Konsolenausgaben des Szenarios landen auf stdout. */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/* ---------- Werkzeuge finden ---------- */

function nvmModuleDirs() {
  const base = join(homedir(), '.nvm/versions/node');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .reverse()
    .flatMap((v) => [
      join(base, v, 'lib/node_modules/@playwright/test'),
      join(base, v, 'lib/node_modules'),
    ]);
}

function loadPlaywright() {
  const paths = [root, ...nvmModuleDirs()];
  for (const name of ['playwright-core', 'playwright']) {
    try {
      return require(require.resolve(name, { paths }));
    } catch {
      // naechster Kandidat
    }
  }
  throw new Error(
    'playwright-core nicht gefunden. Gesucht in: ' + paths.join(', ') +
    '\nEntweder `npm install -D playwright-core` im Repo, oder global `npm i -g @playwright/test`.',
  );
}

function findChrome() {
  if (process.env.COLONY_CHROME) return process.env.COLONY_CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  if (!existsSync(base)) throw new Error('Kein Chromium unter ' + base + ' — COLONY_CHROME setzen.');
  const dirs = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const d of dirs) {
    const bin = join(base, d, 'chrome-linux64/chrome');
    if (existsSync(bin)) return bin;
  }
  throw new Error('Kein chrome-linux64/chrome unter ' + base);
}

/* ---------- Server ---------- */

/** Startet `node src/server.mjs --port <port>` im Repo-Root und wartet auf die
 *  Zeile "Agent Colony -> http://localhost:N". 0 = freier Port. Zurueck kommt
 *  { port, url, stop }, und `stop()` beendet genau diesen Prozess. */
export function startServer(port = 0, { timeoutMs = 15000 } = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/server.mjs'), '--port', String(port)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Server antwortete nicht binnen ' + timeoutMs + ' ms:\n' + out));
    }, timeoutMs);
    child.stdout.on('data', (buf) => {
      out += buf;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (!m) return;
      clearTimeout(timer);
      const p = Number(m[1]);
      resolveP({ port: p, url: 'http://localhost:' + p, stop: () => child.kill() });
    });
    child.stderr.on('data', (buf) => { out += buf; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Server beendet mit Code ' + code + ':\n' + out));
    });
  });
}

/* ---------- Seite ---------- */

/** Oeffnet die Karte in headless Chromium (1500x950, die Referenzgroesse aus
 *  drive.mjs selbst) und wartet, bis der erste State gerendert ist. `mode`
 *  setzt den Renderer schon vor dem ersten Laden, wie ein Nutzer, der ihn
 *  beim letzten Besuch gewaehlt hat. */
export async function openPage(url, planet, { mode, skin } = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  if (mode) await page.addInitScript((m) => localStorage.setItem('colony.renderer', m), mode);
  if (skin) await page.addInitScript((s) => localStorage.setItem('colony.skin', s), skin);
  // Ohne Planet zeigt die Seite den ersten aus der Config.
  await page.goto(url + (planet ? '/#' + planet : '/'));
  await waitReady(page);
  // Ein unbekannter Planet faellt im Frontend still auf den ersten zurueck.
  // Typischer Fall: ein Worktree oder eine git-archive-Kopie ohne die
  // gitignorierte colony.local.json -- dann gibt es nur den Auffang-Planeten,
  // und jedes Bild zeigt die falsche Kolonie.
  const known = await mod(page, (m) => m.store.app.state.planets.map((p) => p.id));
  if (planet && !known.includes(planet)) {
    await browser.close();
    throw new Error(
      `Planet "${planet}" gibt es in diesem Checkout nicht (bekannt: ${known.join(', ')}). ` +
        `Fehlt config/colony.local.json (in einem Worktree als Link auf die des Hauptcheckouts)?`,
    );
  }
  return { browser, page };
}

async function waitReady(page, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const ready = await mod(page, (m) => Boolean(m.store.app.state && m.store.planet()));
    if (ready) break;
    if (Date.now() - t0 > timeoutMs) throw new Error('Seite hat keinen State geladen');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(150); // ein Frame, damit q/r gesetzt und gezeichnet sind
}

/** Fuehrt `fn(m, ...args)` in der Seite aus, wobei `m` die Frontend-Module
 *  traegt: store, map, view, hexmap, collapse, anchors, hud, renderer. `fn`
 *  muss eine in sich geschlossene Funktion sein (keine Closure-Variablen). */
export function mod(page, fn, ...args) {
  return page.evaluate(async ([src, a]) => {
    const [store, map, view, hexmap, collapse, anchors, hud, renderer] = await Promise.all([
      import('/colony/store.mjs'), import('/colony/map.mjs'), import('/colony/view.mjs'),
      import('/colony/hexmap.mjs'), import('/colony/collapse.mjs'), import('/colony/anchors.mjs'),
      import('/colony/hud.mjs'), import('/colony/renderer.mjs'),
    ]);
    const f = new Function('m', 'a', 'return (' + src + ')(m, ...a)');
    return f({ store, map, view, hexmap, collapse, anchors, hud, renderer }, a);
  }, [fn.toString(), args]);
}

/* ---------- Helfer ---------- */

const toScreen = (m, wx, wy) => ({
  x: innerWidth / 2 + m.store.view.x + wx * m.store.view.zoom,
  y: innerHeight / 2 + m.store.view.y + wy * m.store.view.zoom,
});

export const h = {
  /** Zaehler des State. */
  counts: (page) => mod(page, (m) => m.store.app.state.counts),

  /** Felder des sichtbaren Planeten, kompakt. */
  hexes: (page) =>
    mod(page, (m) =>
      m.store.planet().hexes.map((x) => ({
        id: x.id, title: x.title, q: x.q, r: x.r, hidden: Boolean(x.hidden),
        parentId: x.parentId, satellites: x.satellites, agents: x.agents.length,
      })),
    ),

  /** Nur Wurzeln mit Zelle — die Liste, die man vor/nach einem Reload vergleicht. */
  rootCells: (page) =>
    mod(page, (m) => {
      const p = m.store.planet();
      const idx = m.hexmap.index(p.hexes);
      return p.hexes.filter((x) => m.hexmap.rootOf(x, idx) === x).map((x) => [x.id, x.q, x.r]);
    }),

  planetId: (page) => mod(page, (m) => m.store.app.planetId),

  switchPlanet: (page, id) =>
    mod(page, (m, id) => {
      m.store.app.planetId = id;
      location.hash = id;
      m.renderer.fitView();
      m.hud.renderHud();
      m.renderer.scheduleTick();
    }, id),

  toggle: (page, id) => mod(page, (m, id) => m.store.app.toggleFamily(id), id),
  select: (page, id) => mod(page, (m, id) => m.store.app.selectHex(id), id),
  reorder: (page) => mod(page, (m) => m.store.app.reorder()),
  maybeReorder: (page) => mod(page, (m) => m.store.app.maybeReorder()),
  draw: (page) => mod(page, (m) => m.renderer.draw(performance.now())),

  /** Aktiver Renderer: '2d' | '3d'. */
  mode: (page) => mod(page, (m) => m.renderer.mode()),
  /** Umschalten wie der Knopf im HUD; liefert den Modus danach. Der Knopf
   *  ruft nach dem Umschalten renderHud() (aria-pressed nachziehen) — ohne
   *  das hier bliebe der Knopf nach einem Szenario-Umschalten optisch auf
   *  dem alten Modus stehen, obwohl der Renderer schon gewechselt hat. */
  setMode: (page, name) => mod(page, async (m, name) => { await m.renderer.setMode(name); m.hud.renderHud(); return m.renderer.mode(); }, name),

  /** Skin der 3D-Ansicht ('clean' | 'kit'); ausserhalb von 3D 'clean'. */
  skin: (page) => mod(page, (m) => m.store.app.skin?.() ?? 'clean'),
  /** Umschalten wie der Knopf; wartet auf Laden und Rebuild, liefert den Skin danach. */
  setSkin: (page, name) => mod(page, async (m, name) => { const r = await m.store.app.setSkin?.(name); m.hud.renderHud(); return r ?? 'clean'; }, name),

  /** Zustand einer Fahrt: null oder { t0, ms }. */
  move: (page) => mod(page, (m) => m.store.app.move),

  collapsed: (page) => mod(page, (m) => [...m.store.app.collapsed]),
  anchors: (page) => page.evaluate(() => localStorage.getItem('colony.anchors')),
  clearStorage: (page) => page.evaluate(() => localStorage.clear()),

  /** Eine erfundene Figur auf ein Feld setzen (irgendein Planet), dann zeichnen.
   *  state: 'working' | 'prompt' | 'waiting' | 'idle'. `extra` ueberschreibt
   *  einzelne Felder, z.B. { statusSource: 'hook', liveSubagents: 2 } fuer
   *  ein Panel-Szenario. Liefert true bei Treffer.
   *  ageMinutes ist 10, nicht 0: eine Figur juenger als NEW_MAX_AGE liefe in
   *  3D erst vom Hangar zu ihrem Feld (motion.mjs) und staende erst nach
   *  rund 20 s dort, wo ein Szenario sie erwartet. Wer den Hangar-Weg sehen
   *  will, gibt { ageMinutes: 0 } mit. */
  injectAgent: (page, hexId, state = 'prompt', extra = {}) =>
    mod(page, (m, hexId, state, extra) => {
      const hex = m.store.app.state.planets.flatMap((p) => p.hexes).find((x) => x.id === hexId);
      if (!hex) return false;
      hex.agents.push({
        key: 'drive-' + Date.now(), parentKey: null, dir: '', sessionId: 'drive', cwd: '', cwds: [],
        gitBranch: null, sub: false, name: 'drive', agentType: null, task: null, spawnDepth: null,
        scratchpad: false, lastActivity: new Date().toISOString(), ageMinutes: 10, pending: null, state,
        statusSource: 'transcript', liveSubagents: null,
        ...extra,
      });
      m.renderer.draw(performance.now());
      return true;
    }, hexId, state, extra),

  /** Bildschirmposition der Wabe, waehrend einer Fahrt interpoliert — im
   *  aktiven Renderer: 2D ueber den View, 3D projiziert. Delegiert an
   *  screenOf (unten), das `h` ist zum Aufrufzeitpunkt schon vollstaendig. */
  hexScreenPos: (page, id) => h.screenOf(page, id),
  /** Bildschirmposition des Chips. Nur 2D: in 3D ist der Chip ein eigener
   *  DOM-Knoten (labels.mjs) und klickt sich selbst, siehe clickChip. */
  chipScreenPos: (page, id) =>
    mod(page, (m, id) => {
      const x = m.store.planet().hexes.find((q) => q.id === id);
      const c = m.view.hexCenter(x);
      const wx = c.x + m.collapse.CHIP_DX;
      const wy = c.y + m.collapse.CHIP_DY;
      return { x: innerWidth / 2 + m.store.view.x + wx * m.store.view.zoom, y: innerHeight / 2 + m.store.view.y + wy * m.store.view.zoom };
    }, id),

  /** Bildschirmposition der Wabenmitte im aktiven Renderer — 2D ueber den View, 3D projiziert. */
  screenOf: (page, id) =>
    mod(page, async (m, id) => {
      const x = m.store.planet().hexes.find((q) => q.id === id);
      if (m.renderer.mode() === '3d') {
        const [{ anchorScreen }, { worldOf }] = await Promise.all([import('/colony/r3d/pick.mjs'), import('/colony/r3d/world.mjs')]);
        return anchorScreen(worldOf(x, m.hexmap.index(m.store.planet().hexes)));
      }
      const c = m.view.hexCenter(x);
      return { x: innerWidth / 2 + m.store.view.x + c.x * m.store.view.zoom, y: innerHeight / 2 + m.store.view.y + c.y * m.store.view.zoom };
    }, id),

  /** Nur 2D: in 3D ist der Chip ein DOM-Button und klickt selbst (labels.mjs). */
  async hoverChip(page, id) {
    const p = await h.chipScreenPos(page, id);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(60);
    return p;
  },
  async clickHex(page, id) {
    const p = await h.hexScreenPos(page, id);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(60);
    return p;
  },
  /** Nur 2D: in 3D ist der Chip ein DOM-Button und klickt selbst (labels.mjs). */
  async clickChip(page, id) {
    const p = await h.chipScreenPos(page, id);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(60);
    return p;
  },
  /** Welche Wabe die Trefferpruefung an einer Bildschirmposition liefert. */
  hexAt: (page, sx, sy) => mod(page, (m, sx, sy) => m.view.hexAt(sx, sy)?.id ?? null, sx, sy),

  hudHeight: (page) => page.evaluate(() => document.getElementById('hud').offsetHeight),
  cursor: (page) => page.evaluate(() => document.getElementById('colony').style.cursor),
  panelHtml: (page) => page.evaluate(() => document.getElementById('panel-body').innerHTML),

  /** Polling anhalten, damit ein injizierter Zustand nicht in 5 s ueberschrieben wird. */
  freeze: (page) => page.route('**/api/state', (r) => r.abort()),

  shot: (page, path) => page.screenshot({ path }),
  wait: (page, ms) => page.waitForTimeout(ms),
};

/* ---------- Rahmen ---------- */

/** Server (falls kein Port genannt) und Seite hochfahren, `fn` ausfuehren,
 *  alles wieder abbauen — auch bei Fehlern. */
export async function withPage({ port, planet, mode, skin }, fn) {
  const server = port ? { port: Number(port), url: 'http://localhost:' + port, stop: () => {} } : await startServer(0);
  let browser;
  try {
    const opened = await openPage(server.url, planet, { mode, skin });
    browser = opened.browser;
    return await fn({ page: opened.page, h, server });
  } finally {
    if (browser) await browser.close();
    server.stop();
  }
}

/* ---------- CLI ---------- */

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  const port = arg('--port');
  const mode = arg('--mode');
  const skin = arg('--skin');
  /* Async IIFE statt Top-Level-await: ein Szenario, das `mod` aus dieser
   * Datei importiert (scripts/scenarios/3d-switch.mjs), bildet sonst einen
   * Zyklus mit dem noch nicht abgeschlossenen Top-Level-await hier — Node
   * meldet "unsettled top-level await" und beendet den Prozess mit Code 13,
   * ohne die Seite ueberhaupt zu oeffnen (geprueft). Ohne eigenes Top-Level-
   * await ist dieses Modul synchron fertig ausgewertet, bevor der dynamische
   * Import des Szenarios es zurueck-importiert — der Zyklus loest sich. */
  (async () => {
    try {
      if (cmd === 'shot' && a && b) {
        await withPage({ port, planet: a, mode, skin }, async ({ page }) => {
          await h.shot(page, b);
          console.log('geschrieben:', b);
        });
      } else if (cmd === 'run' && a) {
        const scenario = (await import(pathToFileURL(resolve(a)).href)).default;
        await withPage({ port, planet: arg('--planet'), mode, skin }, scenario);
      } else {
        console.error('Aufruf: drive.mjs shot <planet> <out.png> [--port N] [--mode 3d] [--skin kit] | run <szenario.mjs> [--planet X] [--port N] [--mode 3d] [--skin kit]');
        process.exit(2);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
