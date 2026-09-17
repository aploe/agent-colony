import { readdir, realpath, stat } from 'node:fs/promises';
import { repoRoot } from './git.mjs';

/** Unter-Repos unterhalb eines bestehenden Feldes.
 *
 *  Ausgangspunkt ist immer ein Ordner, in dem eine Session lief — es wird
 *  nichts neu ueber Git entdeckt. Abgestiegen wird nur in Ordner, die selbst
 *  kein Repo sind: sobald einer eins ist, wird er Satellit und es geht nicht
 *  weiter hinein. Ohne diese Bremse lieferte ein Webapp-Checkout bei Tiefe 3
 *  vierundfuenfzig Extension-Klone statt null (gemessen 2026-09-11).
 *
 *  Ein Repo erkennt man am vorhandenen `.git` — ein `stat`, kein
 *  Prozessstart. Erst der Worktree-Filter unten kostet Git. */
const isRepo = (p) => stat(p + '/.git').then(() => true).catch(() => false);

/** Ein Verzeichnisbaum bis Tiefe `max`, Symlinks eingeschlossen.
 *
 *  `stat` statt `e.isDirectory()`: das Dirent sagt bei einem Symlink nur
 *  "ist ein Symlink", nicht, worauf er zeigt. `stat` folgt ihm. Gegen
 *  Schleifen (ein Link auf einen Vorfahren) und Doppelgaenger (zwei Links
 *  auf dasselbe Repo) laeuft ein Set der echten Pfade mit — was schon
 *  gesehen wurde, wird nicht noch einmal betreten. Gemeldet wird der Pfad,
 *  wie er im Baum steht, denn den sieht der Nutzer; eindeutig gemacht wird
 *  ueber `realpath`.
 *
 *  Exportiert nur fuer Proben gegen konstruierte Baeume (Symlink-Schleifen).
 *  Aufrufer im Projekt gibt es keinen — `findSubRepos` ist die Schnittstelle. */
export async function descend(base, max, skip, seen, depth = 1) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  await Promise.all(
    entries.map(async (e) => {
      // Punkt-Verzeichnisse raus: das faengt `.git`, `.worktrees` und
      // `.claude/worktrees` in einem ab. Ein Worktree ist kein eigenes
      // Projekt, sondern eine Sicht auf dasselbe Repo.
      if (e.name.startsWith('.') || skip.includes(e.name)) return;
      const p = base + '/' + e.name;
      const st = await stat(p).catch(() => null);
      if (!st?.isDirectory()) return;
      const real = await realpath(p).catch(() => null);
      // Zwischen dem await oben und `seen.add` liegt kein weiteres await —
      // die Pruefung ist damit atomar, auch wenn Promise.all die Eintraege
      // gleichzeitig bearbeitet.
      if (!real || seen.has(real)) return;
      seen.add(real);
      if (await isRepo(p)) out.push(p);
      else if (depth < max) out.push(...(await descend(p, max, skip, seen, depth + 1)));
    }),
  );
  return out;
}

export async function findSubRepos(basePath, cfg) {
  const { depth = 2, maxSatellites = 12, skipDirs = [] } = cfg.subRepos ?? {};
  // Der Ausgangspunkt selbst steht von Anfang an im Set: ein Link zurueck auf
  // ihn (`sub/back -> ..`) waere sonst die kuerzeste Schleife.
  const seen = new Set([await realpath(basePath).catch(() => basePath)]);
  const found = (await descend(basePath, depth, skipDirs, seen)).sort();
  if (!found.length) return { paths: [], capped: null };

  // Ein Kandidat, dessen Haupt-Repo dasselbe ist wie das des Parents, ist ein
  // Worktree oder eine Sicht derselben Sache und kein eigenes Projekt.
  const baseRoot = await repoRoot(basePath);
  const roots = await Promise.all(found.map((p) => repoRoot(p)));
  const own = found.filter((p, i) => roots[i] && roots[i] !== baseRoot);

  // Mehr als der Deckel heisst: Checkout-Baum, kein Projektverbund. Dann gar
  // keine Satelliten, nur die Zahl fuers Panel — sonst erzeugte eine Session
  // in `webapp/source` vierundfuenfzig Waben.
  if (own.length > maxSatellites) return { paths: [], capped: own.length };
  return { paths: own, capped: null };
}
