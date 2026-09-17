import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { loadClaudeProjects } from './sources/claudeProjects.mjs';
import { loadAgents, assignAgents } from './sources/sessions.mjs';
import { setGitCacheSeconds, dayKeys } from './sources/git.mjs';
import { scanProjects } from './sources/scan.mjs';
import { attachNotes } from './sources/notes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadConfig() {
  const base = JSON.parse(await readFile(join(root, 'config/colony.config.json'), 'utf8'));
  // Lokale Overrides sind gitignored — Pfade pro Maschine ohne Repo-Diff
  const localFile = join(root, 'config/colony.local.json');
  let cfg = base;
  let text = null;
  try {
    text = await readFile(localFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (text !== null) {
    // Ein Tippfehler in der lokalen Datei darf nicht still auf die Vorgaben
    // zurueckfallen: die Karte waere dann leer oder falsch, ohne Hinweis.
    let local;
    try {
      local = JSON.parse(text);
    } catch (err) {
      throw new Error(`${localFile} ist kein gueltiges JSON: ${err.message}`);
    }
    if (local === null || typeof local !== 'object' || Array.isArray(local)) {
      throw new Error(`${localFile} muss ein JSON-Objekt sein`);
    }
    cfg = { ...base, ...local, thresholds: { ...base.thresholds, ...local.thresholds } };
  }
  // Der Standardort von Claude Code. Die eingecheckte Config nennt keinen
  // Pfad, weil sie auf jeder Maschine gelten soll.
  cfg.claudeProjectsDir ??= join(homedir(), '.claude', 'projects');
  return cfg;
}

export async function collect(cfg) {
  // Git ist die teuerste Quelle und der traegste Zustand — eigene, laengere
  // TTL, damit haeufiges Pollen die Agentenfiguren aktualisiert, ohne jedes
  // Mal siebzig Git-Prozesse zu starten.
  setGitCacheSeconds(cfg.gitCacheSeconds ?? 20);

  // Ein Durchlauf durch ~/.claude/projects fuer beide Quellen. Getrennt
  // gelaufen statteten sie dieselben ~1100 Dateien doppelt — das war die
  // Haelfte der Erhebungszeit.
  const scanned = await scanProjects(cfg.claudeProjectsDir, cfg.ignoreDirs ?? []);

  const hexes = await loadClaudeProjects(cfg, scanned);
  await attachNotes(hexes, cfg);

  const agents = await loadAgents(cfg, scanned);
  const unassigned = assignAgents(hexes, agents);

  const fallbackPlanet = cfg.planets[cfg.planets.length - 1].id;
  const planets = cfg.planets.map((planet) => ({
    ...planet,
    // Kein Layout mehr: die Positionen rechnet der Browser, weil das
    // Zuklappen einer Familie sie aendert. Siehe public/colony/hexmap.mjs.
    hexes: hexes.filter((h) => h.planet === planet.id),
    station: {
      label: 'Hangar',
      q: 0,
      r: 0,
      // Agenten ohne Feld sammeln sich sichtbar in der Mitte, statt still zu
      // verschwinden. Ein voller Hangar heisst: ignoreCwdPrefixes pruefen.
      agents: planet.id === fallbackPlanet ? unassigned : [],
    },
  }));

  return {
    generatedAt: new Date().toISOString(),
    // Nur was das Frontend fuer Links braucht. Ohne Distro bleibt der
    // VS-Code-Link weg, statt eine geratene URI zu bauen.
    config: {
      wslDistro: cfg.wslDistro ?? process.env.WSL_DISTRO_NAME ?? null,
      // Das Frontend soll sein Intervall nicht raten muessen
      pollSeconds: cfg.pollSeconds ?? 3,
      // Sprache der Beschriftungen (public/i18n/<code>.json). Vorgabe
      // englisch; kennt der Browser die Datei nicht, bleibt es dabei und die
      // Konsole sagt es (public/colony/i18n.mjs).
      language: cfg.language ?? 'en',
      // Schattenwurf der 3D-Ansicht. Fehlt der Schluessel, bleibt es beim
      // bisherigen Bild: an. Aus spart die Schattenkarte je Frame (gemessen
      // 2026-09-16, fundus/messungen/2026-09-16-ressourcen).
      shadows: cfg.shadows !== false,
      // Hoechstens so viele Frames pro Sekunde fuer die Dauer-Animation
      // (laufende Figuren, pulsierende Blasen) in beiden Renderern, und
      // hoechstens diese Pixeldichte fuer die 3D-Flaeche (2D zeichnet immer
      // mit voller Dichte). null = keine Grenze wie vor 2026-09-16, 3D bleibt
      // dann bei hoechstens 2.
      maxFps: cfg.maxFps ?? null,
      maxPixelRatio3d: cfg.maxPixelRatio3d ?? null,
      // Stellschrauben der Umordnung; das Frontend soll sie nicht raten.
      reorder: {
        ringDelta: cfg.reorder?.ringDelta ?? 2,
        cooldownSeconds: cfg.reorder?.cooldownSeconds ?? 60,
        animateMs: cfg.reorder?.animateMs ?? 400,
      },
    },
    // Die Kalendertage zu hex.commitsByDay, aeltester zuerst
    days: dayKeys(),
    counts: {
      projects: hexes.length,
      satellites: hexes.filter((h) => h.parentId).length,
      sessions: hexes.reduce((n, h) => n + h.sessions.total, 0),
      agents: agents.length,
      // Hauptsessions mit lebendem Prozess — die Zahl der Fenster, die
      // gerade wirklich offen sind. Subagenten haben keinen eigenen Prozess.
      open: agents.filter((a) => a.open === true && !a.sub).length,
      // Figuren, deren Zustand vom Hook kommt statt aus dem Transkript.
      // Faellt die Zahl unerwartet auf 0, ist der Hook nicht mehr registriert.
      hookStatus: agents.filter((a) => a.statusSource === 'hook').length,
      prompt: agents.filter((a) => a.state === 'prompt').length,
      working: agents.filter((a) => a.state === 'working').length,
      waiting: agents.filter((a) => a.state === 'waiting').length,
      dirty: hexes.filter((h) => h.gitState === 'dirty').length,
      unpushed: hexes.filter((h) => h.gitState === 'unpushed').length,
      unassigned: unassigned.length,
    },
    planets,
  };
}

if (process.argv.includes('--print')) {
  const cfg = await loadConfig();
  console.log(JSON.stringify(await collect(cfg), null, 2));
}
