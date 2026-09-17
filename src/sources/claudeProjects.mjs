import { readdir, stat, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { repoRoot, repoState } from './git.mjs';
import { scanProjects } from './scan.mjs';
import { lastRecordMs } from './transcript.mjs';
import { findSubRepos } from './subRepos.mjs';

const DAY = 86400000;

/** Claude Code kodiert den cwd als Verzeichnisnamen und ersetzt dabei `/`,
 *  `_` und `.` jeweils durch `-`. Belegt an drei Faellen:
 *    /home/user/10_shop                           -> -home-user-10-shop
 *    /home/user/.claude                           -> -home-user--claude
 *    .../design-system/.claude/worktrees/...      -> ...-design-system--claude-worktrees-...
 *  Die Abbildung ist nicht umkehrbar — deshalb wird sie nur vorwaerts benutzt. */
export const encodePath = (p) => p.replace(/[/_.]/g, '-');

/** Echter Projektpfad zu einem kodierten Verzeichnisnamen.
 *
 *  Statt zu dekodieren wird von einem bekannten cwd aus nach oben gelaufen,
 *  bis die Kodierung eines Vorfahren auf den Verzeichnisnamen passt. Damit
 *  ist die Zuordnung eindeutig, obwohl die Kodierung verlustbehaftet ist.
 *  Ohne das zerfiel ein Projekt `team/websites` in ein Feld, das nach einem
 *  tief verschachtelten Unterordner hiess — dem cwd des zuletzt geschriebenen
 *  Subagenten-Transkripts. */
function pathFromDirName(dirName, cwd) {
  let p = cwd;
  while (p && p !== '/' && p !== '.') {
    if (encodePath(p) === dirName) return p;
    p = dirname(p);
  }
  return null;
}

/** Zweiter Weg: den Verzeichnisnamen gegen das Dateisystem aufloesen.
 *
 *  Noetig, weil manche Sessions als einzigen cwd einen Scratchpad-Pfad
 *  enthalten (`/tmp/claude-1000/<encoded>/…/scratchpad`) und damit keinen
 *  Anker fuer den Aufstieg liefern. Ein Projekt mit 88 Transkripten fiel
 *  dadurch lautlos aus der Karte.
 *
 *  Es wird nur in Zweige abgestiegen, deren Kodierung ein Prefix des
 *  Zielnamens ist — der Suchraum bleibt damit winzig. Die Mehrdeutigkeit der
 *  Kodierung wird hier zugunsten des ersten Treffers aufgeloest; bei
 *  `team-websites` vs `team/websites` entscheidet, was real existiert. */
async function pathFromFilesystem(dirName, depth = 6) {
  async function descend(prefix, level) {
    if (level > depth) return null;
    let entries;
    try {
      entries = await readdir(prefix || '/', { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const candidate = `${prefix}/${e.name}`;
      const encoded = encodePath(candidate);
      if (encoded === dirName) return candidate;
      if (dirName.startsWith(encoded + '-')) {
        const hit = await descend(candidate, level + 1);
        if (hit) return hit;
      }
    }
    return null;
  }
  return descend('', 0);
}

/** Liest nur den Dateischwanz. Einzelne Transkripte sind bis 9 MB gross. */
async function readTail(file, bytes = 262144) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Alle cwd-Werte eines Transkripts, aeltester zuerst. */
async function cwdsOf(file) {
  const text = await readTail(file).catch(() => '');
  return [...text.matchAll(/"cwd":"([^"]+)"/g)].map((m) => m[1]);
}

/** Ein Projektverzeichnis aus den bereits erhobenen Eintraegen zusammenfassen.
 *
 *  Tiefe 0 sind Hauptsessions, alles darunter (<sessionId>/subagents/) sind
 *  Subagenten-Transkripte. Getrennt gezaehlt, weil 72 Sessions mit 461
 *  Subagenten etwas anderes aussagen als 533 Sessions.
 *
 *  Laeuft nicht mehr selbst durchs Dateisystem — die Eintraege kommen aus
 *  `scan.mjs`, damit derselbe Baum pro Erhebung nur einmal abgegangen wird. */
async function scanDir(entries, name, freshBefore) {
  const out = {
    dir: name,
    sessions: { total: 0, fresh: 0 },
    subagents: 0,
    newestMs: 0, // Aktivitaet: juengster Record (unten)
    newestFileMs: 0, // juengste mtime, nur fuer die Wahl von newestFile
    newestFile: null,
    newestSessionMs: 0,
    newestSessionFile: null,
  };

  for (const e of entries) {
    if (e.depth === 0) {
      out.sessions.total++;
      // Bewusst nach mtime: fuer den Zaehler alle Schwaenze zu lesen waere
      // der Preis nicht wert, er faerbt nichts und steht nur im Panel.
      if (e.mtimeMs >= freshBefore) out.sessions.fresh++;
      // Eigener Zaehler: gegen newestMs verglichen (das auch Subagenten
      // enthaelt) gewann nie eine Hauptsession, und die Pfadrekonstruktion
      // bekam Scratchpad-cwds statt echter Projektpfade.
      if (e.mtimeMs > out.newestSessionMs) {
        out.newestSessionMs = e.mtimeMs;
        out.newestSessionFile = e.path;
      }
    } else {
      out.subagents++;
    }
    if (e.mtimeMs > out.newestFileMs) {
      out.newestFileMs = e.mtimeMs;
      out.newestFile = e.path;
    }
  }
  if (!out.sessions.total && !out.subagents) return null;

  // Aktivitaet des Feldes = juengster Rollen-Record, nicht juengste mtime
  // (transcript.mjs erklaert, warum). Nach mtime absteigend lesen und
  // aufhoeren, sobald keine Datei mehr juenger sein kann als der beste
  // Record — ein Record liegt nie hinter der mtime seiner Datei. Im
  // Normalfall ist das nach der ersten Datei; nur nach einem externen
  // Massen-Touch liest es weiter, und dann einmal, der Cache haelt es.
  let best = 0;
  for (const e of [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (e.mtimeMs <= best) break;
    const t = (await lastRecordMs(e).catch(() => null)) ?? e.mtimeMs;
    if (t > best) best = t;
  }
  out.newestMs = best;
  return out;
}

const planetFor = (path, planets) => {
  const hit = planets.find((p) =>
    p.prefixes?.some((pre) => path === pre || path.startsWith(pre + '/')),
  );
  // Letzter Planet ist der Auffangplanet (leere prefixes-Liste)
  return (hit ?? planets[planets.length - 1]).id;
};

/** Baut die Hexfelder aus ~/.claude/projects.
 *
 *  Gruppierungsachse ist der Git-Repo-Root. Ein Worktree unter
 *  .claude/worktrees/ und ein Unterverzeichnis wie
 *  webapp/source/extensions/Search sind keine eigenen Projekte,
 *  sondern Sichten auf dasselbe Repo — sie werden zusammengelegt und
 *  erscheinen im Detail-Panel als `members`.
 *
 *  Verzeichnisse ohne Repo (team/websites, team/automation, notes)
 *  bleiben eigenstaendige Felder ueber ihren Pfad. */
export async function loadClaudeProjects(cfg, scanned0) {
  const { activeDays, quietDays, freshSessionDays } = cfg.thresholds;
  const freshBefore = Date.now() - freshSessionDays * DAY;

  // Die Eintraege kommen normalerweise vom Aufrufer, damit sie sich der
  // Agenten-Quelle teilen. Ohne Argument selbst scannen — dann bleibt der
  // Aufruf fuer sich allein benutzbar (`npm run collect`, Messungen).
  const entries = scanned0 ?? (await scanProjects(cfg.claudeProjectsDir, cfg.ignoreDirs ?? []));

  const byDir = new Map();
  for (const e of entries) {
    if (!byDir.has(e.dir)) byDir.set(e.dir, []);
    byDir.get(e.dir).push(e);
  }

  const scanned = [];
  for (const [name, group] of byDir) {
    const s = await scanDir(group, name, freshBefore);
    if (s) scanned.push(s);
  }

  const resolved = [];
  for (const s of scanned) {
    if (!s.newestFile) continue;
    const cwds = await cwdsOf(s.newestSessionFile ?? s.newestFile);
    // Projektpfad aus dem Verzeichnisnamen rekonstruieren; jeder cwd des
    // Transkripts ist ein gueltiger Startpunkt fuer den Aufstieg.
    let path = null;
    for (const cwd of cwds) {
      path = pathFromDirName(s.dir, cwd);
      if (path) break;
    }
    // Fallback ueber das Dateisystem, danach als letztes der rohe cwd
    path ??= await pathFromFilesystem(s.dir);
    path ??= cwds[0] ?? null;
    if (!path || path === '/') continue;
    if (cfg.ignorePaths?.includes(path)) continue;
    if (cfg.ignoreCwdPrefixes?.some((p) => path.startsWith(p))) continue;

    const exists = await stat(path).then((st) => st.isDirectory()).catch(() => false);
    const gitRoot = exists ? await repoRoot(path) : null;
    resolved.push({ ...s, path, exists, key: gitRoot ?? path, isRepo: Boolean(gitRoot) });
  }

  const groups = new Map();
  for (const r of resolved) {
    const g = groups.get(r.key);
    if (!g) {
      groups.set(r.key, {
        id: r.key,
        path: r.key,
        title: basename(r.key) || r.key,
        isRepo: r.isRepo,
        exists: r.exists,
        sessions: { total: r.sessions.total, fresh: r.sessions.fresh },
        subagents: r.subagents,
        lastActivityMs: r.newestMs,
        members: [r.path],
        // Kodierte Verzeichnisnamen unter ~/.claude/projects, aus denen das
        // Feld gebaut wurde. Exakter Schluessel fuer die Agenten-Zuordnung:
        // ein Transkript liegt immer im Verzeichnis seines Start-cwd.
        dirs: [r.dir],
      });
      continue;
    }
    g.sessions.total += r.sessions.total;
    g.sessions.fresh += r.sessions.fresh;
    g.subagents += r.subagents;
    g.lastActivityMs = Math.max(g.lastActivityMs, r.newestMs);
    if (!g.members.includes(r.path)) g.members.push(r.path);
    if (!g.dirs.includes(r.dir)) g.dirs.push(r.dir);
  }

  const hexes = [];
  for (const g of groups.values()) {
    const git = g.isRepo ? await repoState(g.path) : null;
    const days = Math.floor((Date.now() - g.lastActivityMs) / DAY);

    // Fuellfarbe aus der letzten Agent-Aktivitaet, nicht aus Git: die Karte
    // zeigt, wo Claude gearbeitet hat, nicht wo committet wurde.
    let state = 'stale';
    if (days <= activeDays) state = 'active';
    else if (days <= quietDays) state = 'quiet';

    hexes.push({
      ...g,
      planet: planetFor(g.path, cfg.planets),
      daysSinceActivity: days,
      lastActivity: new Date(g.lastActivityMs).toISOString(),
      state,
      branch: git?.branch ?? null,
      dirty: git?.dirty ?? 0,
      ahead: git?.ahead ?? null,
      hasUpstream: git?.hasUpstream ?? false,
      commits7d: git?.commits7d ?? 0,
      // 14 Kalendertage, aeltester zuerst; Beschriftung in state.days.
      // null statt lauter Nullen, wenn es kein Repo ist.
      commitsByDay: git?.commitsByDay ?? null,
      // Rand: fehlendes Verzeichnis schlaegt alles — das Projekt ist eine Ruine
      gitState: !g.exists ? 'missing' : git ? git.state : 'norepo',
      note: null,
      agents: [],
    });
  }

  /* Quelle 2: ein bestehendes Feld, dessen Pfad unter dem eines anderen
   * liegt, wird dessen Satellit — in beliebiger Dateisystemtiefe, weil es
   * schon existiert und nichts kostet. Laengster Prefix gewinnt: `parentId`
   * zeigt auf den UNMITTELBAREN Elternordner. Frueher gewann der kuerzeste
   * (der oberste Vorfahre), damit das Layout mit genau zwei Ebenen auskam —
   * das Panel schrieb dann aber "Gehoert zu <Grossvater>", eine falsche
   * Aussage ueber das Dateisystem. Seit das Layout Familien ueber `rootOf`
   * bildet (hexmap.mjs), darf die Kette beliebig lang sein.
   *
   * `o.planet === h.planet` ist Teil der Bedingung: eine Config, deren
   * Prefixe in der falschen Reihenfolge verschachteln, koennte sonst ein Kind
   * einem Parent auf einem anderen Planeten zuordnen, und das Kind faende
   * seinen Parent im Array seines Planeten nicht — keine Koordinaten, NaN
   * auf der Karte. */
  const under = (p, base) => p !== base && p.startsWith(base + '/');
  for (const h of hexes) {
    const parent = hexes
      .filter((o) => under(h.path, o.path) && o.planet === h.planet)
      .sort((a, b) => b.path.length - a.path.length)[0];
    h.parentId = parent?.id ?? null;
    h.origin = 'session';
    h.satellites = 0;
    h.satellitesCapped = null;
  }

  /* Quelle 1: entdeckte Unter-Repos. Nur unter Feldern, die es wirklich
   * gibt — eine Ruine hat nichts, in das man absteigen koennte. Pfade, die
   * schon ein Feld sind, fallen raus: Quelle 2 hat sie oben bereits
   * zugeordnet, und ein Feld mit eigenen Sessions darf seine Zahlen nicht
   * gegen Nullen tauschen. */
  const known = new Set(hexes.map((h) => h.path));
  const discovered = [];
  for (const h of hexes) {
    // Jedes Sessionfeld entdeckt eigene Unter-Repos, auch wenn es selbst
    // unter einem anderen Feld liegt — es ist ein echtes Projekt mit
    // Sessions. Entdeckte Satelliten (origin 'discovered') kommen erst nach
    // dieser Schleife dazu und entdecken nichts; die Familie kann also nur
    // ueber Sessionfelder tiefer werden.
    if (!h.exists) continue;
    const { paths, capped } = await findSubRepos(h.path, cfg);
    h.satellitesCapped = capped;
    const accepted = paths.filter((p) => !known.has(p));
    for (const p of accepted) known.add(p);
    // Git-Zustand parallel statt seriell abfragen: der reine `repoState`-
    // Aufruf fuer zehn Satelliten braucht parallel rund 50-75 ms (eigene
    // Messung 2026-09-11, sechs Wiederholungen mit abgeschaltetem Cache,
    // Median 54 ms; ohne Entdeckung und ohne den Worktree-Filter-Pass —
    // Ende-zu-Ende-Zahlen dazu in docs/HISTORIE.md), seriell waere es ein
    // Vielfaches (Prozessstart ist unter WSL der teure Teil, siehe git.mjs).
    // Die Reihenfolge der Waben kommt trotzdem aus `paths` (bereits
    // sortiert), nicht aus der Ankunftsreihenfolge der Promises.
    const gitStates = await Promise.all(accepted.map((p) => repoState(p)));
    accepted.forEach((p, i) => {
      const git = gitStates[i];
      discovered.push({
        id: p,
        path: p,
        // Pfad relativ zum Container, nicht nur der Basename: sonst hiessen
        // shared/templates und templates beide "templates".
        title: p.slice(h.path.length + 1),
        planet: h.planet,
        parentId: h.id,
        origin: 'discovered',
        isRepo: true,
        exists: true,
        // Kein eigenes Transkript, also keine ehrliche Aktivitaetsfarbe.
        // null statt 'stale' — die Wabe bleibt hohl, bis dort ein Agent
        // arbeitet. Siehe "Ehrlichkeit vor Vollstaendigkeit".
        state: null,
        daysSinceActivity: null,
        lastActivity: null,
        sessions: { total: 0, fresh: 0 },
        subagents: 0,
        members: [p],
        dirs: [],
        branch: git.branch,
        dirty: git.dirty,
        ahead: git.ahead,
        hasUpstream: git.hasUpstream,
        commits7d: git.commits7d,
        commitsByDay: git.commitsByDay,
        gitState: git.state,
        note: null,
        agents: [],
        satellites: 0,
        satellitesCapped: null,
      });
    });
  }
  hexes.push(...discovered);
  for (const h of hexes) h.satellites = hexes.filter((o) => o.parentId === h.id).length;

  return hexes;
}
