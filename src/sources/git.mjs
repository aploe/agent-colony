import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(dir, args) {
  try {
    const { stdout } = await exec('git', ['-C', dir, ...args], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/* Git ist mit Abstand die teuerste Quelle: sieben Prozessstarts pro Repo,
 * ueber elf Repos rund 435 ms von 530 ms einer ganzen Erhebung. Unter WSL
 * kostet vor allem das Starten selbst.
 *
 * Genau dieser Teil ist aber der traegste Zustand auf der Karte — ein Repo
 * wird nicht im Sekundentakt dirty. Ein eigener, laengerer Cache macht damit
 * schnelles Pollen fuer die Agentenfiguren bezahlbar, ohne die Erhebung
 * aufzuteilen. Kein persistenter Zustand: nur In-Memory, faellt mit dem
 * Serverprozess. */
const cache = new Map();

async function cached(key, ttlMs, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await produce();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Die Kalendertage der Skyline: heute und die 13 Tage davor, lokale Zeit,
 *  aeltester zuerst, als `YYYY-MM-DD`. Der Collector legt sie einmal in den
 *  State, damit das Frontend die Balken beschriften kann, ohne selbst
 *  "heute" zu raten. */
export const DAY_COUNT = 14;

export function dayKeys(now = new Date()) {
  const d = new Date(now);
  // Mittag statt Mitternacht: ueber eine Sommerzeit-Umstellung hinweg
  // wuerde setDate() sonst um eine Stunde in den Nachbartag kippen.
  d.setHours(12, 0, 0, 0);
  const keys = [];
  for (let i = DAY_COUNT - 1; i >= 0; i--) {
    const t = new Date(d);
    t.setDate(d.getDate() - i);
    keys.push(localDate(t));
  }
  return keys;
}

function localDate(t) {
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

/** Sekunden, die Git-Ergebnisse gelten. 0 schaltet den Cache ab. */
let ttlMs = 20000;
export function setGitCacheSeconds(seconds) {
  ttlMs = Math.max(0, Number(seconds) || 0) * 1000;
}

/** Root des **Haupt**-Repos, oder null wenn es keins ist.
 *
 *  Gruppierungsachse der ganzen Karte. Bewusst ueber `--git-common-dir`
 *  statt `--show-toplevel`: in einem Worktree liefert show-toplevel den
 *  Worktree selbst, und ein Worktree bekam dadurch ein eigenes Hexfeld
 *  neben seinem Repo. common-dir zeigt dagegen immer auf das .git des
 *  Hauptrepos.
 *
 *  Ein echtes Unter-Repo (Submodul wie webapp/.../extensions/Search) hat sein
 *  eigenes common-dir und bleibt korrekt ein eigenes Feld. */
export async function repoRoot(dir) {
  // Laenger gecacht als der Rest: wo ein Repo-Root liegt, aendert sich
  // praktisch nie — nur beim Anlegen oder Loeschen eines Repos.
  return cached('root:' + dir, ttlMs * 3, async () => {
    const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common) {
      const root = common.replace(/\/\.git\/?$/, '');
      if (root !== common) return root;
    }
    return await git(dir, ['rev-parse', '--show-toplevel']);
  });
}

/** Arbeitszustand fuer die Hex-Umrandung.
 *
 *  Prioritaet: dirty > unpushed > clean. Uncommittete Aenderungen zuerst,
 *  weil das der einzige Zustand ist, in dem Arbeit verloren gehen kann.
 *  `ahead` ohne Upstream ist nicht messbar — ein Branch ohne Remote gilt
 *  deshalb pauschal als unpushed, sobald er Commits hat. */
export async function repoState(root) {
  return cached('state:' + root, ttlMs, () => collectRepoState(root));
}

async function collectRepoState(root) {
  const days = dayKeys();
  const [branch, porcelain, ahead, upstream, commits] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['status', '--porcelain']),
    git(root, ['rev-list', '--count', '@{u}..HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', '@{u}']),
    // Ein Committer-Datum je Zeile, in lokaler Zeit — `--since` filtert
    // ebenfalls nach Committer-Datum, und ein blankes Datum meint dort
    // Mitternacht lokal. Author-Datum waere bei Rebases das aeltere und
    // passte nicht zu dem, was `--since` durchlaesst.
    git(root, ['log', '--since=' + days[0], '--format=%cd', '--date=format-local:%Y-%m-%d']),
  ]);

  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  const aheadCount = ahead === null ? null : Number(ahead);
  const hasUpstream = upstream !== null;

  // Commits je Kalendertag, gleiche Reihenfolge wie dayKeys(). Zeilen
  // ausserhalb des Fensters (Zukunftsdaten, Zeitzonen-Ausreisser) fallen weg.
  const perDay = new Map(days.map((k) => [k, 0]));
  for (const line of (commits ?? '').split('\n')) {
    if (perDay.has(line)) perDay.set(line, perDay.get(line) + 1);
  }
  const commitsByDay = days.map((k) => perDay.get(k));
  // Kalendertage statt rollender 7x24 h wie frueher: heute plus sechs Tage.
  const commits7d = commitsByDay.slice(-7).reduce((a, b) => a + b, 0);

  let state = 'clean';
  if (dirty > 0) state = 'dirty';
  else if (aheadCount > 0 || (!hasUpstream && commits7d > 0)) state = 'unpushed';

  return { branch, dirty, ahead: aheadCount, hasUpstream, commits7d, commitsByDay, state };
}
