#!/usr/bin/env node
/* Traegt den Status-Hook in ~/.claude/settings.json ein oder wieder aus.
 *
 * Warum ueberhaupt global und nicht ins Repo: Hooks aus <repo>/.claude/
 * feuern nur in Sessions, deren cwd dieses Projekt ist. Die Karte will den
 * Zustand ALLER Projekte — die Registrierung muss also maschinenweit sein,
 * auch wenn das Skript selbst im Repo liegt und dort versioniert bleibt.
 *
 * Warum kein Plugin: ein installiertes Plugin ist eine Kopie im Cache. Jede
 * Aenderung am Hook braeuchte /plugin update, Schreiber und Leser wuerden
 * driften. Begruendung in der Spec.
 *
 * Der Installer ist Komfort, keine Voraussetzung — der Eintrag laesst sich
 * von Hand setzen, siehe README.
 */
import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
];

const commandFor = (hookPath, event) => `bash ${hookPath} ${event}`;
const isOurs = (entry, hookPath) =>
  entry?.type === 'command' && typeof entry.command === 'string' && entry.command.includes(hookPath);

/** Fuegt fehlende Eintraege ein und laesst alles andere unberuehrt. */
export function applyHooks(settings, hookPath) {
  const out = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const event of EVENTS) {
    const matchers = [...(out.hooks[event] ?? [])].map((m) => ({ ...m, hooks: [...m.hooks] }));
    const already = matchers.some((m) => m.hooks.some((h) => isOurs(h, hookPath)));
    if (already) {
      out.hooks[event] = matchers;
      continue;
    }
    matchers.push({
      matcher: '',
      hooks: [{ type: 'command', command: commandFor(hookPath, event) }],
    });
    out.hooks[event] = matchers;
  }
  return out;
}

/** Entfernt nur die eigenen Eintraege und raeumt danach Leergut weg. */
export function removeHooks(settings, hookPath) {
  const out = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const event of EVENTS) {
    const matchers = (out.hooks[event] ?? [])
      .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h, hookPath)) }))
      .filter((m) => m.hooks.length > 0);
    if (matchers.length) out.hooks[event] = matchers;
    else delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

/** Erkennt einen verlinkten Worktree rein aus den beiden Git-Pfaden -- ruft
 * selbst kein Git auf, damit sich die Logik ohne echtes Repo testen laesst.
 * Im Hauptcheckout liefern `git rev-parse --git-dir` und `--git-common-dir`
 * denselben Pfad; in einem verlinkten Worktree zeigt `--git-dir` auf
 * `<hauptrepo>/.git/worktrees/<name>`, waehrend `--git-common-dir`
 * weiterhin auf das geteilte `.git` des Hauptcheckouts zeigt. Fehlt einer
 * der beiden Werte (kein Git installiert, oder root ist kein Repo), ist die
 * Frage gegenstandslos -- kein Worktree ohne Repo, also kein Abbruch.
 * Ergibt eine Fehlermeldung, wenn root ein Worktree ist, sonst null.
 */
export function worktreeGuard(gitDir, gitCommonDir) {
  if (!gitDir || !gitCommonDir || gitDir === gitCommonDir) return null;
  const mainCheckout = dirname(gitCommonDir);
  return (
    `Dieses Skript liegt in einem verlinkten Worktree (--git-dir=${gitDir}). ` +
    `Der Hook-Pfad wuerde relativ zu diesem wegwerfbaren Checkout eingetragen ` +
    `und beim naechsten "git worktree remove" still wirkungslos -- ohne dass ` +
    `irgendwo etwas darauf hinweist. Bitte stattdessen aus dem Hauptcheckout ` +
    `aufrufen: ${mainCheckout}`
  );
}

/** Bricht die Installation ab, wenn der Hook-Pfad (noch) nicht existiert --
 *  sonst tragen wir acht Ereignisse ein, die auf ein fehlendes Skript
 *  zeigen, und jedes davon ruft in jeder Session `bash <fehlt>` auf (Exit
 *  127 + stderr), bis zur naechsten Installation. Konkreter Fall: aus dem
 *  Hauptcheckout heraus installieren, waehrend `hooks/session-status.sh`
 *  noch nur im Worktree existiert (vor dem Merge dieser Branch). Betrifft
 *  nur die Installation -- beim Entfernen ist die Existenz des Skripts ohne
 *  Bedeutung, es werden nur passende Eintraege aus der Settings-Datei
 *  genommen. Ergibt eine Fehlermeldung, wenn der Pfad fehlt, sonst null. */
export function checkHookExists(hookPath) {
  if (existsSync(hookPath)) return null;
  return `${hookPath} existiert nicht -- nichts eingetragen. Erst wenn das Skript dort liegt (z.B. nach dem Merge dieser Branch), erneut installieren.`;
}

/** Liest die Settings-Datei und ermittelt die Baseline fuer den
 * Kollisionsschutz. Zwei Faelle, sauber getrennt statt in einem gemeinsamen
 * try/catch verschliffen:
 *  - Datei war da: Baseline ist ihre mtime. Schlaegt das anschliessende
 *    `stat` trotzdem fehl (z.B. weil die Datei zwischen `readFile` und
 *    `stat` verschwunden ist), wirft diese Funktion weiter -- main() bricht
 *    dann ab, statt ungeschuetzt weiterzumachen.
 *  - Datei war nicht da (ENOENT beim Lesen): Baseline ist "existiert nicht".
 * Ein anderer Lesefehler (z.B. EACCES) ist kein "Datei gibt es nicht" und
 * wird nicht wie ENOENT behandelt, sondern wirft ebenfalls weiter.
 */
export async function readBaseline(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '{}', existed: false, mtimeMs: null };
    throw new Error(`${file} kann nicht gelesen werden (${err.code}) -- nichts geschrieben.`);
  }
  try {
    const { mtimeMs } = await stat(file);
    return { text, existed: true, mtimeMs };
  } catch {
    throw new Error(
      `${file} ist zwischen Lesen und Pruefen verschwunden -- nichts geschrieben. Nochmal starten.`,
    );
  }
}

/** Prueft unmittelbar vor dem Schreiben, ob die Baseline aus readBaseline
 * noch gilt. Ergibt eine Fehlermeldung, wenn nicht, sonst null.
 *  - Baseline "war da": die Datei muss weiterhin existieren und dieselbe
 *    mtime tragen wie beim ersten Lesen.
 *  - Baseline "war nicht da": die Datei darf immer noch nicht existieren --
 *    ist sie inzwischen aufgetaucht, hat ein anderes Werkzeug sie in der
 *    Zwischenzeit angelegt, und die "Lieber abbrechen als ueberschreiben"-
 *    Zusage muss auch fuer diesen Fall gelten, nicht nur fuer eine bereits
 *    vorhandene Datei.
 */
export async function checkBaseline(file, baseline) {
  if (baseline.existed) {
    let mtimeMs;
    try {
      ({ mtimeMs } = await stat(file));
    } catch {
      return `${file} ist inzwischen verschwunden -- nichts geschrieben. Nochmal starten.`;
    }
    if (mtimeMs !== baseline.mtimeMs) {
      return `${file} hat sich waehrenddessen geaendert -- nichts geschrieben. Nochmal starten.`;
    }
    return null;
  }
  try {
    await stat(file);
  } catch {
    return null; // stat wirft weiterhin -- Datei existiert immer noch nicht.
  }
  return `${file} ist inzwischen entstanden -- nichts geschrieben. Nochmal starten.`;
}

async function main() {
  const args = process.argv.slice(2);
  const uninstall = args.includes('--uninstall');
  const at = args.indexOf('--settings');
  const file = at >= 0 ? args[at + 1] : join(homedir(), '.claude', 'settings.json');
  const hookPath = join(root, 'hooks', 'session-status.sh');

  if (!uninstall) {
    const missing = checkHookExists(hookPath);
    if (missing) {
      console.error(missing);
      process.exit(1);
    }
  }

  // Der Worktree-Schutz gilt nur dem echten Ziel: Bei --settings zeigt file
  // explizit auf eine andere Datei (typisch eine Testkopie im Scratchpad),
  // und die Frage "friert der Hook-Pfad in einem wegwerfbaren Worktree ein"
  // stellt sich dort nicht -- der Aufrufer weiss, was er tut. Nur ohne
  // --settings, also gegen die echte ~/.claude/settings.json, wuerde ein
  // Worktree-Pfad dort haengen bleiben und beim naechsten
  // "git worktree remove" still wirkungslos werden. Deshalb loest allein
  // "kein --settings" die Pruefung aus, nicht z.B. "uninstall vs. install"
  // -- beide Richtungen wuerden denselben kaputten Pfad schreiben bzw.
  // aus der Datei suchen.
  if (at < 0) {
    let gitDir = null;
    let gitCommonDir = null;
    try {
      const out = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], {
        cwd: root,
        encoding: 'utf8',
        // Ledger-Minor #6: ein haengender git-Prozess soll den Installer nie
        // unbegrenzt blockieren.
        timeout: 5000,
      });
      [gitDir, gitCommonDir] = out.trim().split('\n');
    } catch {
      // Kein Git installiert oder root ist kein Repo -- dann kann root auch
      // kein Worktree sein, die Frage ist gegenstandslos. Nicht blockieren.
    }
    const blocked = worktreeGuard(gitDir, gitCommonDir);
    if (blocked) {
      console.error(blocked);
      process.exit(1);
    }
  }

  // Auf dieser Maschine laufen regelmaessig mehrere Sessions parallel, und
  // andere Werkzeuge schreiben dieselbe Datei. Lieber abbrechen als
  // ueberschreiben — der Nutzer verliert sonst lautlos eine Aenderung. Das
  // gilt fuer beide Baseline-Faelle: Datei war schon da (mtime muss gleich
  // bleiben) und Datei war noch nicht da (sie darf nicht dazwischen
  // auftauchen).
  let baseline;
  try {
    baseline = await readBaseline(file);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
    return;
  }

  let settings;
  try {
    settings = JSON.parse(baseline.text);
  } catch (err) {
    console.error(`${file} enthaelt kein gueltiges JSON (${err.message}) -- nichts geschrieben.`);
    process.exit(1);
    return;
  }
  const next = uninstall ? removeHooks(settings, hookPath) : applyHooks(settings, hookPath);

  // Nichts zu tun heisst nichts schreiben: ein zweiter Installer-Lauf formatiert
  // sonst die Datei eines anderen Werkzeugs um, und ein --uninstall ohne
  // Eintraege legte eine settings.json an, die es vorher nicht gab.
  if (JSON.stringify(next) === JSON.stringify(settings)) {
    console.log(
      uninstall
        ? `Keine Eintraege von Agent Colony in ${file} -- nichts geschrieben.`
        : `Schon eingetragen: ${EVENTS.length} Ereignisse in ${file} -- nichts geschrieben.`,
    );
    return;
  }

  const problem = await checkBaseline(file, baseline);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  const tmp = `${file}.agent-colony.tmp`;
  // Auf einer Maschine, auf der Claude Code noch nie lief, fehlt ~/.claude.
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
  console.log(`${uninstall ? 'Entfernt' : 'Eingetragen'}: ${EVENTS.length} Ereignisse in ${file}`);
  console.log(`Hook: ${hookPath}`);
}

if (process.argv[1]?.endsWith('install-hooks.mjs')) await main();
